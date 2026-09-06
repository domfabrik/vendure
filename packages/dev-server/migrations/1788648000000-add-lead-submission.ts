import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLeadSubmission1788648000000 implements MigrationInterface {
    private orderTable(runner: QueryRunner) {
        return this.table(runner).replace(/"lead_submission"$/, '"order"');
    }
    private table(runner: QueryRunner) {
        const schema = (runner.connection.options as { schema?: string }).schema ?? 'public';
        return `${runner.connection.driver.escape(schema)}."lead_submission"`;
    }
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(
            `ALTER TABLE ${this.orderTable(runner)} ADD COLUMN IF NOT EXISTS "customFieldsLeadoriginchannel" character varying(255)`,
        );
        await runner.query(`CREATE TABLE ${this.table(runner)} (
            "id" SERIAL NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
            "channelId" character varying NOT NULL, "sessionId" character varying NOT NULL,
            "tokenHash" character varying(64) NOT NULL, "fingerprint" character varying(64) NOT NULL,
            "orderId" character varying NOT NULL, "receipt" jsonb NOT NULL, "contact" jsonb NOT NULL, "notificationBody" text NOT NULL,
            "notificationState" character varying NOT NULL DEFAULT 'pending', "attemptedAt" TIMESTAMP,
            CONSTRAINT "PK_lead_submission" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_lead_submission_scope_token" UNIQUE ("channelId", "sessionId", "tokenHash"),
            CONSTRAINT "UQ_lead_submission_order" UNIQUE ("orderId"),
            CONSTRAINT "CK_lead_notification_state" CHECK ("notificationState" IN ('pending','attempting','sent','failed','ambiguous'))
        )`);
    }
    async down(runner: QueryRunner): Promise<void> {
        // Never discard receipts or notification history during an application rollback.
        await runner.query(`LOCK TABLE ${this.table(runner)} IN ACCESS EXCLUSIVE MODE`);
        await runner.query(`LOCK TABLE ${this.orderTable(runner)} IN ACCESS EXCLUSIVE MODE`);
        const rows = await runner.query(`SELECT 1 FROM ${this.table(runner)} LIMIT 1`);
        if (rows.length) throw new Error('Lead submission rollback requires an empty table');
        // Origin markers on existing carts are data too; preserve them on application rollback.
        const markedOrders = await runner.query(
            `SELECT 1 FROM ${this.orderTable(runner)} WHERE "customFieldsLeadoriginchannel" IS NOT NULL LIMIT 1`,
        );
        if (markedOrders.length) throw new Error('Lead submission rollback requires no marked orders');
        await runner.query(`DROP TABLE ${this.table(runner)}`);
        await runner.query(
            `ALTER TABLE ${this.orderTable(runner)} DROP COLUMN "customFieldsLeadoriginchannel"`,
        );
    }
}
