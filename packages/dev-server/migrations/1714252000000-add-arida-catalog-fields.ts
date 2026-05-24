import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAridaCatalogFields1714252000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product"
            ADD COLUMN IF NOT EXISTS "vendorName" character varying(255),
            ADD COLUMN IF NOT EXISTS "sourceUrl" character varying(1024),
            ADD COLUMN IF NOT EXISTS "sourceProductId" character varying(255),
            ADD COLUMN IF NOT EXISTS "rawCharacteristicsJson" text,
            ADD COLUMN IF NOT EXISTS "packageCount" integer,
            ADD COLUMN IF NOT EXISTS "warrantyMonths" integer,
            ADD COLUMN IF NOT EXISTS "weightKg" double precision,
            ADD COLUMN IF NOT EXISTS "volumeM3" double precision,
            ADD COLUMN IF NOT EXISTS "dimensionsMm" text,
            ADD COLUMN IF NOT EXISTS "includedItems" text,
            ADD COLUMN IF NOT EXISTS "decor" text,
            ADD COLUMN IF NOT EXISTS "additionalInfo" text,
            ADD COLUMN IF NOT EXISTS "packagingNotes" text,
            ADD COLUMN IF NOT EXISTS "maxLoadKg" double precision,
            ADD COLUMN IF NOT EXISTS "minimumDoorWidthCm" double precision,
            ADD COLUMN IF NOT EXISTS "frameMaterialText" text,
            ADD COLUMN IF NOT EXISTS "facadeMaterialText" text,
            ADD COLUMN IF NOT EXISTS "edgeMaterialText" text,
            ADD COLUMN IF NOT EXISTS "shelfMaterialText" text,
            ADD COLUMN IF NOT EXISTS "hardwareText" text,
            ADD COLUMN IF NOT EXISTS "frontHardwareText" text,
            ADD COLUMN IF NOT EXISTS "drawerMaterialText" text,
            ADD COLUMN IF NOT EXISTS "countertopMaterialText" text,
            ADD COLUMN IF NOT EXISTS "upholsteryText" text,
            ADD COLUMN IF NOT EXISTS "kitchenShape" character varying(255),
            ADD COLUMN IF NOT EXISTS "kitchenElements" text,
            ADD COLUMN IF NOT EXISTS "countertopDimensionsMm" text,
            ADD COLUMN IF NOT EXISTS "bedDimensionsMm" text,
            ADD COLUMN IF NOT EXISTS "recommendedMattressHeightMm" integer,
            ADD COLUMN IF NOT EXISTS "mattressInsetMm" integer,
            ADD COLUMN IF NOT EXISTS "mattressBase" text
        `);

        await queryRunner.query(`
            ALTER TABLE "product_variant"
            ADD COLUMN IF NOT EXISTS "sourceSkuId" character varying(255),
            ADD COLUMN IF NOT EXISTS "sourceVariantUrl" character varying(1024),
            ADD COLUMN IF NOT EXISTS "oldPrice" integer,
            ADD COLUMN IF NOT EXISTS "finishLabel" character varying(255),
            ADD COLUMN IF NOT EXISTS "finishDescription" text,
            ADD COLUMN IF NOT EXISTS "upholsteryLabel" character varying(255),
            ADD COLUMN IF NOT EXISTS "upholsteryDescription" text,
            ADD COLUMN IF NOT EXISTS "profileLabel" character varying(255),
            ADD COLUMN IF NOT EXISTS "profileDescription" text
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product_variant"
            DROP COLUMN IF EXISTS "profileDescription",
            DROP COLUMN IF EXISTS "profileLabel",
            DROP COLUMN IF EXISTS "upholsteryDescription",
            DROP COLUMN IF EXISTS "upholsteryLabel",
            DROP COLUMN IF EXISTS "finishDescription",
            DROP COLUMN IF EXISTS "finishLabel",
            DROP COLUMN IF EXISTS "oldPrice",
            DROP COLUMN IF EXISTS "sourceVariantUrl",
            DROP COLUMN IF EXISTS "sourceSkuId"
        `);

        await queryRunner.query(`
            ALTER TABLE "product"
            DROP COLUMN IF EXISTS "mattressBase",
            DROP COLUMN IF EXISTS "mattressInsetMm",
            DROP COLUMN IF EXISTS "recommendedMattressHeightMm",
            DROP COLUMN IF EXISTS "bedDimensionsMm",
            DROP COLUMN IF EXISTS "countertopDimensionsMm",
            DROP COLUMN IF EXISTS "kitchenElements",
            DROP COLUMN IF EXISTS "kitchenShape",
            DROP COLUMN IF EXISTS "upholsteryText",
            DROP COLUMN IF EXISTS "countertopMaterialText",
            DROP COLUMN IF EXISTS "drawerMaterialText",
            DROP COLUMN IF EXISTS "frontHardwareText",
            DROP COLUMN IF EXISTS "hardwareText",
            DROP COLUMN IF EXISTS "shelfMaterialText",
            DROP COLUMN IF EXISTS "edgeMaterialText",
            DROP COLUMN IF EXISTS "facadeMaterialText",
            DROP COLUMN IF EXISTS "frameMaterialText",
            DROP COLUMN IF EXISTS "minimumDoorWidthCm",
            DROP COLUMN IF EXISTS "maxLoadKg",
            DROP COLUMN IF EXISTS "packagingNotes",
            DROP COLUMN IF EXISTS "additionalInfo",
            DROP COLUMN IF EXISTS "decor",
            DROP COLUMN IF EXISTS "includedItems",
            DROP COLUMN IF EXISTS "dimensionsMm",
            DROP COLUMN IF EXISTS "volumeM3",
            DROP COLUMN IF EXISTS "weightKg",
            DROP COLUMN IF EXISTS "warrantyMonths",
            DROP COLUMN IF EXISTS "packageCount",
            DROP COLUMN IF EXISTS "rawCharacteristicsJson",
            DROP COLUMN IF EXISTS "sourceProductId",
            DROP COLUMN IF EXISTS "sourceUrl",
            DROP COLUMN IF EXISTS "vendorName"
        `);
    }
}
