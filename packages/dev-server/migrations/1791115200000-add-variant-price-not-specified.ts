import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVariantPriceNotSpecified1791115200000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product_variant"
            ADD COLUMN IF NOT EXISTS "customFieldsPricenotspecified" boolean
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product_variant"
            DROP COLUMN IF EXISTS "customFieldsPricenotspecified"
        `);
    }
}
