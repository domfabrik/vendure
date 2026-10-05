import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sanitizerPath = fileURLToPath(new URL('./sanitize-catalog-observability.mjs', import.meta.url));
const services = [
  { name: 'storefront', containerSuffix: 'storefront-1' },
  { name: 'vendure', containerSuffix: 'vendure-server-1' },
];
const maxRawBytes = 32 * 1024 * 1024;
const maxMetadataBytes = 64 * 1024;
const defaultTimeoutMs = 120_000;

export async function captureCatalogObservability(options, dependencies = {}) {
  const environment = exactValue(options.environment, ['test', 'prod'], 'environment');
  const sshUser = safeUser(options.sshUser);
  const sshHost = safeHost(options.sshHost);
  const runnerTemp = path.resolve(requiredString(options.runnerTemp, 'runner temp'));
  const outputDir = path.resolve(requiredString(options.outputDir, 'output directory'));
  const keyPath = path.resolve(requiredString(options.keyPath ?? path.join(os.homedir(), '.ssh', 'id_ed25519'), 'SSH key path'));
  const relativeOutput = path.relative(runnerTemp, outputDir);
  if (!relativeOutput || relativeOutput.startsWith(`..${path.sep}`) || relativeOutput === '..' || path.isAbsolute(relativeOutput)) {
    throw new Error('capture output directory must be a child of RUNNER_TEMP');
  }

  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const sshExecutable = dependencies.sshExecutable ?? 'ssh';
  const sshBaseArgs = dependencies.sshBaseArgs ?? [];
  const timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs;
  if (!Array.isArray(sshBaseArgs) || !sshBaseArgs.every(value => typeof value === 'string')) throw new Error('invalid SSH process arguments');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultTimeoutMs) throw new Error('invalid capture timeout');

  let createdOutput = false;
  try {
    await mkdir(outputDir, { recursive: false, mode: 0o700 });
    createdOutput = true;
    await chmod(outputDir, 0o700);
    const captures = [];
    for (const service of services) {
      captures.push(await captureService({
        environment,
        keyPath,
        outputDir,
        service,
        spawnImpl,
        sshBaseArgs,
        sshExecutable,
        sshHost,
        sshUser,
        timeoutMs,
      }));
    }
    return { environment, outputDir, captures };
  } catch (error) {
    if (createdOutput) await rm(outputDir, { recursive: true, force: true });
    throw new Error('catalog observability capture failed', { cause: error });
  }
}

async function captureService(options) {
  const container = `fabric-${options.environment}-${options.service.containerSuffix}`;
  const outputPath = path.join(options.outputDir, `${options.environment}-${options.service.name}.jsonl`);
  const manifestPath = path.join(options.outputDir, `${options.environment}-${options.service.name}.manifest.json`);
  const sanitizer = options.spawnImpl(process.execPath, [
    sanitizerPath,
    '--output', outputPath,
    '--manifest', manifestPath,
    '--ttl-hours', '72',
  ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const remoteCommand = `docker logs --timestamps --since 30m ${container} 2>&1`;
  const ssh = options.spawnImpl(options.sshExecutable, [
    ...options.sshBaseArgs,
    '-i', options.keyPath,
    `${options.sshUser}@${options.sshHost}`,
    remoteCommand,
  ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let rawStdoutBytes = 0;
  let rawStderrBytes = 0;
  let rawTotalBytes = 0;
  let metadata = '';
  let metadataBytes = 0;
  let sanitizerErrorBytes = 0;
  let abortReason;
  let sshClosed = false;
  let sanitizerClosed = false;

  const abort = reason => {
    if (abortReason) return;
    abortReason = reason;
    if (!sshClosed) ssh.kill('SIGKILL');
    if (!sanitizerClosed) sanitizer.kill('SIGKILL');
    sanitizer.stdin.destroy();
  };
  const forward = (stream, streamName) => {
    stream.on('data', chunk => {
      if (abortReason) return;
      if (streamName === 'stdout') rawStdoutBytes += chunk.length;
      else rawStderrBytes += chunk.length;
      rawTotalBytes += chunk.length;
      if (rawStdoutBytes > maxRawBytes || rawStderrBytes > maxRawBytes || rawTotalBytes > maxRawBytes) {
        abort('raw stream limit exceeded');
        return;
      }
      if (!sanitizer.stdin.write(chunk)) {
        ssh.stdout.pause();
        ssh.stderr.pause();
      }
    });
  };
  forward(ssh.stdout, 'stdout');
  forward(ssh.stderr, 'stderr');
  sanitizer.stdin.on('drain', () => {
    ssh.stdout.resume();
    ssh.stderr.resume();
  });
  sanitizer.stdin.on('error', () => abort('sanitizer input failed'));
  sanitizer.stdout.on('data', chunk => {
    metadataBytes += chunk.length;
    if (metadataBytes > maxMetadataBytes) abort('sanitizer metadata limit exceeded');
    else metadata += chunk.toString('utf8');
  });
  sanitizer.stderr.on('data', chunk => {
    sanitizerErrorBytes += chunk.length;
    if (sanitizerErrorBytes > maxMetadataBytes) abort('sanitizer error limit exceeded');
  });

  const timeout = setTimeout(() => abort('capture timeout'), options.timeoutMs);
  const sshResultPromise = childResult(ssh, () => {
    sshClosed = true;
    if (!sanitizer.stdin.destroyed) sanitizer.stdin.end();
  });
  const sanitizerResultPromise = childResult(sanitizer, () => {
    sanitizerClosed = true;
    if (!sshClosed) abort('sanitizer exited before SSH');
  });
  const [sshResult, sanitizerResult] = await Promise.all([sshResultPromise, sanitizerResultPromise]);
  clearTimeout(timeout);
  if (abortReason || sshResult.error || sshResult.code !== 0 || sanitizerResult.error || sanitizerResult.code !== 0) {
    throw new Error('capture child failed');
  }

  const lines = metadata.trim().split(/\r?\n/);
  if (lines.length !== 1) throw new Error('invalid sanitizer metadata');
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new Error('invalid sanitizer metadata');
  }
  validateMetadata(parsed, outputPath, manifestPath);
  await Promise.all([chmod(outputPath, 0o600), chmod(manifestPath, 0o600)]);
  const [outputStat, manifestStat] = await Promise.all([stat(outputPath), stat(manifestPath)]);
  if (
    !outputStat.isFile() || !manifestStat.isFile()
    || (process.platform !== 'win32' && ((outputStat.mode & 0o777) !== 0o600 || (manifestStat.mode & 0o777) !== 0o600))
  ) {
    throw new Error('capture artifact permissions are invalid');
  }
  return {
    service: options.service.name,
    container,
    outputPath,
    manifestPath,
    recordCount: parsed.recordCount,
    bytes: parsed.bytes,
    sha256: parsed.sha256,
  };
}

function childResult(child, onClose) {
  return new Promise(resolve => {
    let error;
    child.once('error', value => {
      error = value;
    });
    child.once('close', code => {
      onClose();
      resolve({ code, error });
    });
  });
}

function validateMetadata(value, outputPath, manifestPath) {
  if (!isObject(value) || path.resolve(value.outputPath ?? '') !== outputPath || path.resolve(value.manifestPath ?? '') !== manifestPath) {
    throw new Error('sanitizer paths do not match capture target');
  }
  if (!Number.isInteger(value.recordCount) || value.recordCount < 0 || value.recordCount > 5_000) throw new Error('invalid record count');
  if (!Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > 2 * 1024 * 1024) throw new Error('invalid artifact size');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error('invalid artifact hash');
}

function safeUser(value) {
  const text = requiredString(value, 'SSH user');
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(text)) throw new Error('invalid SSH user');
  return text;
}

function safeHost(value) {
  const text = requiredString(value, 'SSH host');
  if (text.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(text) || text.includes('..')) throw new Error('invalid SSH host');
  return text;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

function exactValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`invalid ${label}`);
  return value;
}

function isObject(value) {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseArgs(values) {
  if (values.length % 2 !== 0) throw new Error('invalid arguments');
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!['--environment', '--output-dir', '--runner-temp', '--ssh-user', '--ssh-host', '--key-path'].includes(key) || result[key]) throw new Error('invalid arguments');
    result[key] = values[index + 1];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await captureCatalogObservability({
    environment: args['--environment'],
    outputDir: args['--output-dir'],
    runnerTemp: args['--runner-temp'] ?? process.env.RUNNER_TEMP,
    sshUser: args['--ssh-user'],
    sshHost: args['--ssh-host'],
    keyPath: args['--key-path'],
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('catalog observability capture failed');
    process.exitCode = 1;
  });
}
