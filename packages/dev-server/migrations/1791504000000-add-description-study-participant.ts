import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDescriptionStudyParticipant1791504000000 implements MigrationInterface {
    private table(runner: QueryRunner, name: string) {
        const schema = (runner.connection.options as { schema?: string }).schema ?? 'public';
        return `${runner.connection.driver.escape(schema)}.${runner.connection.driver.escape(name)}`;
    }
    async up(runner: QueryRunner): Promise<void> {
        const participant = this.table(runner, 'description_study_participant');
        await runner.query(`CREATE TABLE IF NOT EXISTS ${participant} (
            "id" SERIAL PRIMARY KEY, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "channelId" character varying NOT NULL,
            "experimentKey" character varying NOT NULL, "studySessionId" uuid NOT NULL,
            "participantKey" character varying(64) NOT NULL,
            CONSTRAINT "UQ_description_participant_scope_session" UNIQUE ("channelId", "experimentKey", "studySessionId"),
            CONSTRAINT "UQ_description_participant_scope_owner" UNIQUE ("channelId", "experimentKey", "participantKey")
        )`);
        await runner.query(
            `ALTER TABLE ${this.table(runner, 'description_study_ballot')} ADD COLUMN IF NOT EXISTS "studySessionId" uuid`,
        );
    }
    async down(runner: QueryRunner): Promise<void> {
        const participant = this.table(runner, 'description_study_participant');
        const ballot = this.table(runner, 'description_study_ballot');
        await runner.query(`LOCK TABLE ${participant} IN ACCESS EXCLUSIVE MODE`);
        await runner.query(`LOCK TABLE ${ballot} IN ACCESS EXCLUSIVE MODE`);
        if (
            (await runner.query(`SELECT 1 FROM ${participant} LIMIT 1`)).length ||
            (await runner.query(`SELECT 1 FROM ${ballot} WHERE "studySessionId" IS NOT NULL LIMIT 1`)).length
        )
            throw new Error('Description study participant rollback requires empty recovery mappings');
        await runner.query(
            `ALTER TABLE ${this.table(runner, 'description_study_ballot')} DROP COLUMN "studySessionId"`,
        );
        await runner.query(`DROP TABLE ${this.table(runner, 'description_study_participant')}`);
    }
}
