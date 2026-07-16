import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDomfabricSchema1714250000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE SCHEMA IF NOT EXISTS "domfabric"');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP SCHEMA IF EXISTS "domfabric" CASCADE');
    }
}
