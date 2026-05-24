import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAridaCatalogFields1714252000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product"
            ADD COLUMN IF NOT EXISTS "customFieldsVendorname" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsSourceurl" character varying(1024),
            ADD COLUMN IF NOT EXISTS "customFieldsSourceproductid" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsRawcharacteristicsjson" text,
            ADD COLUMN IF NOT EXISTS "customFieldsPackagecount" integer,
            ADD COLUMN IF NOT EXISTS "customFieldsWarrantymonths" integer,
            ADD COLUMN IF NOT EXISTS "customFieldsWeightkg" double precision,
            ADD COLUMN IF NOT EXISTS "customFieldsVolumem3" double precision,
            ADD COLUMN IF NOT EXISTS "customFieldsDimensionsmm" text,
            ADD COLUMN IF NOT EXISTS "customFieldsIncludeditems" text,
            ADD COLUMN IF NOT EXISTS "customFieldsDecor" text,
            ADD COLUMN IF NOT EXISTS "customFieldsAdditionalinfo" text,
            ADD COLUMN IF NOT EXISTS "customFieldsPackagingnotes" text,
            ADD COLUMN IF NOT EXISTS "customFieldsMaxloadkg" double precision,
            ADD COLUMN IF NOT EXISTS "customFieldsMinimumdoorwidthcm" double precision,
            ADD COLUMN IF NOT EXISTS "customFieldsFramematerialtext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsFacadematerialtext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsEdgematerialtext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsShelfmaterialtext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsHardwaretext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsFronthardwaretext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsDrawermaterialtext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsCountertopmaterialtext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsUpholsterytext" text,
            ADD COLUMN IF NOT EXISTS "customFieldsKitchenshape" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsKitchenelements" text,
            ADD COLUMN IF NOT EXISTS "customFieldsCountertopdimensionsmm" text,
            ADD COLUMN IF NOT EXISTS "customFieldsBeddimensionsmm" text,
            ADD COLUMN IF NOT EXISTS "customFieldsRecommendedmattressheightmm" integer,
            ADD COLUMN IF NOT EXISTS "customFieldsMattressinsetmm" integer,
            ADD COLUMN IF NOT EXISTS "customFieldsMattressbase" text
        `);

        await queryRunner.query(`
            ALTER TABLE "product_variant"
            ADD COLUMN IF NOT EXISTS "customFieldsSourceskuid" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsSourcevarianturl" character varying(1024),
            ADD COLUMN IF NOT EXISTS "customFieldsOldprice" integer,
            ADD COLUMN IF NOT EXISTS "customFieldsFinishlabel" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsFinishdescription" text,
            ADD COLUMN IF NOT EXISTS "customFieldsUpholsterylabel" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsUpholsterydescription" text,
            ADD COLUMN IF NOT EXISTS "customFieldsProfilelabel" character varying(255),
            ADD COLUMN IF NOT EXISTS "customFieldsProfiledescription" text
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "product_variant"
            DROP COLUMN IF EXISTS "customFieldsProfiledescription",
            DROP COLUMN IF EXISTS "customFieldsProfilelabel",
            DROP COLUMN IF EXISTS "customFieldsUpholsterydescription",
            DROP COLUMN IF EXISTS "customFieldsUpholsterylabel",
            DROP COLUMN IF EXISTS "customFieldsFinishdescription",
            DROP COLUMN IF EXISTS "customFieldsFinishlabel",
            DROP COLUMN IF EXISTS "customFieldsOldprice",
            DROP COLUMN IF EXISTS "customFieldsSourcevarianturl",
            DROP COLUMN IF EXISTS "customFieldsSourceskuid"
        `);

        await queryRunner.query(`
            ALTER TABLE "product"
            DROP COLUMN IF EXISTS "customFieldsMattressbase",
            DROP COLUMN IF EXISTS "customFieldsMattressinsetmm",
            DROP COLUMN IF EXISTS "customFieldsRecommendedmattressheightmm",
            DROP COLUMN IF EXISTS "customFieldsBeddimensionsmm",
            DROP COLUMN IF EXISTS "customFieldsCountertopdimensionsmm",
            DROP COLUMN IF EXISTS "customFieldsKitchenelements",
            DROP COLUMN IF EXISTS "customFieldsKitchenshape",
            DROP COLUMN IF EXISTS "customFieldsUpholsterytext",
            DROP COLUMN IF EXISTS "customFieldsCountertopmaterialtext",
            DROP COLUMN IF EXISTS "customFieldsDrawermaterialtext",
            DROP COLUMN IF EXISTS "customFieldsFronthardwaretext",
            DROP COLUMN IF EXISTS "customFieldsHardwaretext",
            DROP COLUMN IF EXISTS "customFieldsShelfmaterialtext",
            DROP COLUMN IF EXISTS "customFieldsEdgematerialtext",
            DROP COLUMN IF EXISTS "customFieldsFacadematerialtext",
            DROP COLUMN IF EXISTS "customFieldsFramematerialtext",
            DROP COLUMN IF EXISTS "customFieldsMinimumdoorwidthcm",
            DROP COLUMN IF EXISTS "customFieldsMaxloadkg",
            DROP COLUMN IF EXISTS "customFieldsPackagingnotes",
            DROP COLUMN IF EXISTS "customFieldsAdditionalinfo",
            DROP COLUMN IF EXISTS "customFieldsDecor",
            DROP COLUMN IF EXISTS "customFieldsIncludeditems",
            DROP COLUMN IF EXISTS "customFieldsDimensionsmm",
            DROP COLUMN IF EXISTS "customFieldsVolumem3",
            DROP COLUMN IF EXISTS "customFieldsWeightkg",
            DROP COLUMN IF EXISTS "customFieldsWarrantymonths",
            DROP COLUMN IF EXISTS "customFieldsPackagecount",
            DROP COLUMN IF EXISTS "customFieldsRawcharacteristicsjson",
            DROP COLUMN IF EXISTS "customFieldsSourceproductid",
            DROP COLUMN IF EXISTS "customFieldsSourceurl",
            DROP COLUMN IF EXISTS "customFieldsVendorname"
        `);
    }
}
