import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddScheduledTaskRecord1714251000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const schema = this.getSchema(queryRunner);
        const tableName = this.getTableName(schema);

        if (schema && schema !== 'public') {
            await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        }

        if (await queryRunner.hasTable(tableName)) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                schema,
                name: 'scheduled_task_record',
                columns: [
                    {
                        name: 'id',
                        type: 'integer',
                        isPrimary: true,
                        isGenerated: true,
                        generationStrategy: 'increment',
                    },
                    {
                        name: 'createdAt',
                        type: 'timestamp',
                        precision: 3,
                        default: 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'timestamp',
                        precision: 3,
                        default: 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'taskId',
                        type: 'character varying',
                        isNullable: false,
                        isUnique: true,
                    },
                    {
                        name: 'enabled',
                        type: 'boolean',
                        default: true,
                    },
                    {
                        name: 'lockedAt',
                        type: 'timestamp',
                        precision: 3,
                        isNullable: true,
                    },
                    {
                        name: 'lastExecutedAt',
                        type: 'timestamp',
                        precision: 3,
                        isNullable: true,
                    },
                    {
                        name: 'manuallyTriggeredAt',
                        type: 'timestamp',
                        precision: 3,
                        isNullable: true,
                    },
                    {
                        name: 'lastResult',
                        type: 'json',
                        isNullable: true,
                    },
                ],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tableName = this.getTableName(this.getSchema(queryRunner));

        if (await queryRunner.hasTable(tableName)) {
            await queryRunner.dropTable(tableName);
        }
    }

    private getSchema(queryRunner: QueryRunner): string | undefined {
        const { schema } = queryRunner.connection.driver.options as { schema?: string };
        return typeof schema === 'string' && schema.length > 0 ? schema : undefined;
    }

    private getTableName(schema: string | undefined): string {
        return schema ? `${schema}.scheduled_task_record` : 'scheduled_task_record';
    }
}
