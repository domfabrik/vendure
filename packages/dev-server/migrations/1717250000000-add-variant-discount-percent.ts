import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVariantDiscountPercent1717250000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product_variant"
            ADD COLUMN IF NOT EXISTS "customFieldsDiscountpercent" integer
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product_variant"
            DROP COLUMN IF EXISTS "customFieldsDiscountpercent"
        `);
    }
}
