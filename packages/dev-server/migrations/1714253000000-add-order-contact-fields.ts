import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderContactFields1714253000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "order"
            ADD COLUMN IF NOT EXISTS "customFieldsRecipientfullname" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsRecipientphonenumber" character varying(255)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "order"
            DROP COLUMN IF EXISTS "customFieldsRecipientphonenumber",
            DROP COLUMN IF EXISTS "customFieldsRecipientfullname"
        `);
    }
}
