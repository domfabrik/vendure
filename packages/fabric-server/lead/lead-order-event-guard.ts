import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus, Order, OrderEvent, TransactionalConnection } from '@vendure/core';

import { LeadInputError } from './lead-order.service';
import { LeadSubmission } from './lead-submission.entity';

/** Protect the scalar-contact legacy path too: it has no OrderInterceptor hook in Vendure. */
@Injectable()
export class LeadOrderEventGuard implements OnModuleInit {
    constructor(
        private events: EventBus,
        private connection: TransactionalConnection,
    ) {}
    onModuleInit() {
        this.events.registerBlockingEventHandler({
            event: OrderEvent,
            id: 'fabric-protect-submitted-lead',
            handler: async event => {
                if (event.type === 'created') {
                    event.order.customFields = {
                        ...event.order.customFields,
                        leadOriginChannel: String(event.ctx.channelId),
                    } as any;
                    await this.connection
                        .getRepository(event.ctx, Order)
                        .update(event.order.id, { customFields: event.order.customFields });
                    return;
                }
                if (event.type !== 'updated') return;
                const submitted = await this.connection
                    .getRepository(event.ctx, LeadSubmission)
                    .exists({ where: { orderId: String(event.order.id) } });
                // Throw inside the core transaction. A stale contact update must roll back before legacy email subscribers run.
                if (submitted) throw new LeadInputError('LEAD_ALREADY_SUBMITTED');
            },
        });
    }
}
