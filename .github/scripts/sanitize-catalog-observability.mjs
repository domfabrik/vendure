import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';

process.on('uncaughtException', failSafely);
process.on('unhandledRejection', failSafely);

const args = parseArgs(process.argv.slice(2));
if (!args.output) throw new Error('usage: node scripts/sanitize-catalog-observability.mjs --output PATH [--manifest PATH] [--ttl-hours 72]');
const outputPath = path.resolve(args.output);
const manifestPath = path.resolve(args.manifest ?? `${outputPath}.manifest.json`);
const ttlHours = boundedInteger(Number(args['ttl-hours'] ?? 72), 1, 168, 72);
const maxInputBytes = 32 * 1024 * 1024;
const maxOutputBytes = 2 * 1024 * 1024;
const maxRecords = 5_000;
const prefixes = ['[catalog-observability] ', '[catalog-observability-vendure] ', '[catalog-ssr] '];
let inputBytes = 0;
const limitedInput = new Transform({
  transform(chunk, _encoding, callback) {
    inputBytes += chunk.length;
    callback(inputBytes > maxInputBytes ? new Error('input limit exceeded') : null, chunk);
  },
});
process.stdin.pipe(limitedInput);
const lines = createInterface({ input: limitedInput, crlfDelay: Infinity });
const sanitized = [];
let outputBytes = 0;
let recognizedLines = 0;

for await (const line of lines) {
  const match = findRecord(line);
  if (!match) continue;
  recognizedLines += 1;
  let parsed;
  try {
    parsed = JSON.parse(match.json);
  } catch {
    throw new Error('recognized record contains invalid JSON');
  }
  const record = sanitizeRecord(parsed, match.prefix, match.occurredAt);
  const encoded = `${JSON.stringify(record)}\n`;
  outputBytes += Buffer.byteLength(encoded);
  if (sanitized.length >= maxRecords) throw new Error(`recognized record count exceeds ${maxRecords}`);
  if (outputBytes > maxOutputBytes) throw new Error('sanitized output exceeds the 2 MiB artifact cap');
  sanitized.push(encoded);
}

if (recognizedLines !== sanitized.length) throw new Error('recognized lines were not fully sanitized');
await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(manifestPath), { recursive: true });
const output = sanitized.join('');
await writeFile(outputPath, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
const createdAt = new Date();
const manifest = {
  schemaVersion: 1,
  createdAt: createdAt.toISOString(),
  deleteAfter: new Date(createdAt.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
  ttlHours,
  recordCount: sanitized.length,
  bytes: Buffer.byteLength(output),
  sha256: createHash('sha256').update(output).digest('hex'),
  inputPolicy: 'stdin-only; raw input was not written',
  fieldPolicy: 'schema whitelist v1',
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ outputPath, manifestPath, recordCount: manifest.recordCount, bytes: manifest.bytes, sha256: manifest.sha256 }));

function findRecord(line) {
  const occurredAt = dockerTimestamp(line);
  for (const prefix of prefixes) {
    const index = line.indexOf(prefix);
    if (index >= 0) return { prefix, json: line.slice(index + prefix.length), occurredAt };
  }
  return null;
}

function sanitizeRecord(value, prefix, occurredAt) {
  if (!isObject(value)) throw new Error('recognized record has an unsupported schema');
  if (prefix === prefixes[2]) {
    const operation = enumValue(value.operation, ['GetAllCollections', 'SearchCollectionProducts'], 'operation');
    return {
      schemaVersion: 1,
      ...(occurredAt ? { occurredAt } : {}),
      event: 'legacy-catalog-failure',
      stage: operation === 'GetAllCollections' ? 'header' : 'recommendations',
      operation,
      outcome: 'failure',
      errorClass: legacyErrorClass(value.errorClass),
    };
  }
  if (value.schemaVersion !== 1) throw new Error('recognized record has an unsupported schema');
  const base = {
    schemaVersion: 1,
    ...(occurredAt ? { occurredAt } : {}),
    event: enumValue(value.event, prefix === prefixes[0] ? ['catalog-stage'] : ['vendure-catalog-request'], 'event'),
    requestID: requestID(value.requestID),
    stage: enumValue(value.stage, ['product', 'metadata', 'header', 'recommendations'], 'stage'),
    operation: enumValue(value.operation, ['GetProductBySlug', 'GetAllCollections', 'SearchCollectionProducts'], 'operation'),
    outcome: enumValue(value.outcome, prefix === prefixes[0] ? ['success', 'failure'] : ['slow', 'failure'], 'outcome'),
    durationMs: numberValue(value.durationMs, 'durationMs'),
  };
  if (prefix === prefixes[0]) {
    return value.outcome === 'failure'
      ? { ...base, errorClass: enumValue(value.errorClass, ['Http4xx', 'Http5xx', 'HttpError', 'TimeoutError', 'AbortError', 'RequestError'], 'errorClass') }
      : base;
  }
  return {
    ...base,
    errorClass: enumValue(value.errorClass, ['Http5xx', 'None'], 'errorClass'),
    statusCode: numberValue(value.statusCode, 'statusCode'),
    sqlInstrumentation: enumValue(value.sqlInstrumentation, ['disabled', 'request'], 'sqlInstrumentation'),
    sqlCount: numberValue(value.sqlCount, 'sqlCount'),
    sqlDurationMs: numberValue(value.sqlDurationMs, 'sqlDurationMs'),
    sqlMaxMs: numberValue(value.sqlMaxMs, 'sqlMaxMs'),
    sqlErrors: numberValue(value.sqlErrors, 'sqlErrors'),
    poolAcquireCount: numberValue(value.poolAcquireCount, 'poolAcquireCount'),
    poolWaitMs: numberValue(value.poolWaitMs, 'poolWaitMs'),
    poolMaxWaitMs: numberValue(value.poolMaxWaitMs, 'poolMaxWaitMs'),
    poolAcquireErrors: numberValue(value.poolAcquireErrors, 'poolAcquireErrors'),
    poolTotal: numberValue(value.poolTotal, 'poolTotal'),
    poolIdle: numberValue(value.poolIdle, 'poolIdle'),
    poolWaiting: numberValue(value.poolWaiting, 'poolWaiting'),
  };
}

function dockerTimestamp(line) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z /.exec(line);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
  ) return undefined;
  return match[0].slice(0, -1);
}

function legacyErrorClass(value) {
  if (typeof value !== 'string') throw new Error('errorClass is outside the whitelist');
  if (['Http4xx', 'Http5xx', 'HttpError', 'TimeoutError', 'AbortError', 'RequestError'].includes(value)) return value;
  const match = /^Http([1-5][0-9]{2})$/.exec(value);
  if (!match) throw new Error('errorClass is outside the whitelist');
  const statusCode = Number(match[1]);
  if (statusCode >= 500) return 'Http5xx';
  if (statusCode >= 400) return 'Http4xx';
  return 'HttpError';
}

function requestID(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('requestID is not a process-generated UUID v4');
  }
  return value;
}

function enumValue(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${field} is outside the whitelist`);
  return value;
}

function numberValue(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) throw new Error(`${field} is outside the numeric bounds`);
  return value;
}

function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function isObject(value) {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) result[values[index].replace(/^--/, '')] = values[index + 1];
  return result;
}

function failSafely() {
  console.error('catalog observability sanitization failed');
  process.exit(1);
}
