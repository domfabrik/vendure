import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSearchCollectionSlugsGin1791158400000 implements MigrationInterface {
    private indexName = 'IDX_search_index_item_collection_slugs_gin';

    private table(runner: QueryRunner): string {
        const schema = (runner.connection.options as { schema?: string }).schema ?? 'public';
        return `${runner.connection.driver.escape(schema)}."search_index_item"`;
    }

    public async up(runner: QueryRunner): Promise<void> {
        await runner.query(
            `CREATE INDEX "${this.indexName}" ON ${this.table(runner)} ` +
                `USING GIN (string_to_array("collectionSlugs", ','))`,
        );
    }

    public async down(runner: QueryRunner): Promise<void> {
        const schema = (runner.connection.options as { schema?: string }).schema ?? 'public';
        await runner.query(`DROP INDEX ${runner.connection.driver.escape(schema)}."${this.indexName}"`);
    }
}
