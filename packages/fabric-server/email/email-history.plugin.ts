import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    EventBus,
    HistoryService,
    ID,
    Logger,
    PluginCommonModule,
    VendurePlugin,
} from '@vendure/core';
import { EmailSendEvent } from '@vendure/email-plugin';
import gql from 'graphql-tag';

import { ORDER_EMAIL_SENT } from './email-history.types';

@Injectable()
class OrderEmailHistoryService implements OnModuleInit {
    constructor(
        private eventBus: EventBus,
        private historyService: HistoryService,
    ) {}

    onModuleInit() {
        this.eventBus.ofType(EmailSendEvent).subscribe(event => {
            void this.recordEmail(event);
        });
    }

    private async recordEmail(event: EmailSendEvent) {
        const metadata = event.metadata ?? {};
        const orderId = toOrderId(metadata.orderId);

        if (!orderId) {
            return;
        }

        try {
            await this.historyService.createHistoryEntryForOrder({
                orderId,
                ctx: event.ctx,
                type: ORDER_EMAIL_SENT,
                data: {
                    emailType: toOptionalString(metadata.emailType) ?? 'unknown',
                    success: event.success,
                    from: event.details.from,
                    recipient: event.details.recipient,
                    cc: event.details.cc ?? null,
                    bcc: event.details.bcc ?? null,
                    replyTo: event.details.replyTo ?? null,
                    subject: event.details.subject,
                    body: event.details.body,
                    metadata: sanitizeMetadata(metadata),
                    error: event.error ? `${event.error.name}: ${event.error.message}` : null,
                    sentAt: new Date().toISOString(),
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.error(`Failed to archive order email: ${message}`, 'OrderEmailHistoryService');
        }
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [OrderEmailHistoryService],
    adminApiExtensions: {
        schema: gql`
            extend enum HistoryEntryType {
                ORDER_EMAIL_SENT
            }
        `,
    },
})
export class OrderEmailHistoryPlugin {}

function toOrderId(value: unknown): ID | undefined {
    if (typeof value === 'string' || typeof value === 'number') {
        return value;
    }
    return undefined;
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> | null {
    const sanitized = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
    return Object.keys(sanitized).length > 0 ? sanitized : null;
}
