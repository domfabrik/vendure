import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLeadAttemptedEnvelope1788651000000 implements MigrationInterface {
    private table(runner: QueryRunner) {
        const schema = (runner.connection.options as { schema?: string }).schema ?? 'public';
        return `${runner.connection.driver.escape(schema)}."lead_submission"`;
    }
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(
            `ALTER TABLE ${this.table(runner)} ADD COLUMN IF NOT EXISTS "attemptedEnvelope" jsonb`,
        );
    }
    async down(runner: QueryRunner): Promise<void> {
        await runner.query(`LOCK TABLE ${this.table(runner)} IN ACCESS EXCLUSIVE MODE`);
        const attempts = await runner.query(
            `SELECT 1 FROM ${this.table(runner)} WHERE "attemptedEnvelope" IS NOT NULL LIMIT 1`,
        );
        if (attempts.length) throw new Error('Attempted envelope rollback requires no recorded envelopes');
        await runner.query(`ALTER TABLE ${this.table(runner)} DROP COLUMN "attemptedEnvelope"`);
    }
}
