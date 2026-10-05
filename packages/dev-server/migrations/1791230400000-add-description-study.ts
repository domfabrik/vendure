import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDescriptionStudy1791230400000 implements MigrationInterface {
    private schema(runner: QueryRunner) {
        return (runner.connection.options as { schema?: string }).schema ?? 'public';
    }

    private table(runner: QueryRunner, name: string) {
        return `${runner.connection.driver.escape(this.schema(runner))}.${runner.connection.driver.escape(name)}`;
    }

    async up(runner: QueryRunner): Promise<void> {
        const candidate = this.table(runner, 'description_study_candidate');
        const ballot = this.table(runner, 'description_study_ballot');
        await runner.query(`CREATE TABLE IF NOT EXISTS ${candidate} (
            "id" SERIAL NOT NULL,
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
            "channelId" character varying NOT NULL,
            "experimentKey" character varying NOT NULL,
            "sourceProductId" character varying NOT NULL,
            "slug" character varying NOT NULL,
            "productName" character varying NOT NULL,
            "imageUrl" character varying,
            "sourceUrl" text NOT NULL,
            "sourceKind" character varying NOT NULL,
            "parsedCharacteristics" jsonb NOT NULL,
            "ordinal" integer NOT NULL,
            "oldText" text NOT NULL,
            "newText" text NOT NULL,
            "oldHash" character varying(64) NOT NULL,
            "newHash" character varying(64) NOT NULL,
            "oldVersionId" character varying NOT NULL,
            "newVersionId" character varying NOT NULL,
            "oldEmpty" boolean NOT NULL,
            "vendorName" character varying NOT NULL,
            "productType" character varying NOT NULL,
            "generationMetadata" jsonb NOT NULL,
            "sourceSnapshotSha256" character varying(64) NOT NULL,
            "schemaVersion" integer NOT NULL,
            CONSTRAINT "PK_description_study_candidate" PRIMARY KEY ("id"),
            CONSTRAINT "CK_description_candidate_source_kind" CHECK ("sourceKind" IN ('VENDOR', 'CATALOG')),
            CONSTRAINT "UQ_description_candidate_scope_product" UNIQUE ("channelId", "experimentKey", "sourceProductId"),
            CONSTRAINT "UQ_description_candidate_scope_ordinal" UNIQUE ("channelId", "experimentKey", "ordinal")
        )`);
        await runner.query(`CREATE TABLE IF NOT EXISTS ${ballot} (
            "id" SERIAL NOT NULL,
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
            "ballotToken" uuid NOT NULL,
            "channelId" character varying NOT NULL,
            "experimentKey" character varying NOT NULL,
            "participantKey" character varying(64) NOT NULL,
            "candidateId" integer NOT NULL,
            "leftVersion" character varying NOT NULL,
            "choice" character varying,
            "selectedVersion" character varying,
            "leftComment" text NOT NULL DEFAULT '',
            "rightComment" text NOT NULL DEFAULT '',
            "assignedAt" TIMESTAMP NOT NULL,
            "votedAt" TIMESTAMP,
            CONSTRAINT "PK_description_study_ballot" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_description_ballot_token" UNIQUE ("ballotToken"),
            CONSTRAINT "UQ_description_ballot_scope_participant_candidate" UNIQUE ("channelId", "experimentKey", "participantKey", "candidateId"),
            CONSTRAINT "FK_description_ballot_candidate" FOREIGN KEY ("candidateId") REFERENCES ${candidate}("id") ON DELETE RESTRICT,
            CONSTRAINT "CK_description_ballot_left_version" CHECK ("leftVersion" IN ('OLD', 'NEW')),
            CONSTRAINT "CK_description_ballot_choice" CHECK ("choice" IS NULL OR "choice" IN ('LEFT', 'RIGHT', 'EQUAL', 'SKIP')),
            CONSTRAINT "CK_description_ballot_selected" CHECK ("selectedVersion" IS NULL OR "selectedVersion" IN ('OLD', 'NEW', 'EQUAL', 'SKIP')),
            CONSTRAINT "CK_description_ballot_vote_state" CHECK (
                ("votedAt" IS NULL AND "choice" IS NULL AND "selectedVersion" IS NULL)
                OR ("votedAt" IS NOT NULL AND "choice" IS NOT NULL AND "selectedVersion" IS NOT NULL)
            ),
            CONSTRAINT "CK_description_ballot_comment_size" CHECK (
                char_length("leftComment") <= 2000 AND char_length("rightComment") <= 2000
            )
        )`);
        await runner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_description_ballot_participant_progress" ON ${ballot} ("channelId", "experimentKey", "participantKey", "votedAt")`,
        );
    }

    async down(runner: QueryRunner): Promise<void> {
        const candidate = this.table(runner, 'description_study_candidate');
        const ballot = this.table(runner, 'description_study_ballot');
        if (!(await runner.hasTable(`${this.schema(runner)}.description_study_candidate`))) return;
        await runner.query(`LOCK TABLE ${candidate} IN ACCESS EXCLUSIVE MODE`);
        if (await runner.hasTable(`${this.schema(runner)}.description_study_ballot`)) {
            await runner.query(`LOCK TABLE ${ballot} IN ACCESS EXCLUSIVE MODE`);
            if ((await runner.query(`SELECT 1 FROM ${ballot} LIMIT 1`)).length)
                throw new Error('Description study rollback requires an empty ballot table');
        }
        if ((await runner.query(`SELECT 1 FROM ${candidate} LIMIT 1`)).length)
            throw new Error('Description study rollback requires an empty candidate table');
        if (await runner.hasTable(`${this.schema(runner)}.description_study_ballot`))
            await runner.query(`DROP TABLE ${ballot}`);
        await runner.query(`DROP TABLE ${candidate}`);
    }
}
