import { Injectable, OnModuleInit } from '@nestjs/common';
import { Order, TransactionalConnection } from '@vendure/core';
import { EntitySubscriberInterface, UpdateEvent } from 'typeorm';

import { LeadInputError } from './lead-order.service';

/** Final save boundary: core error-result paths can save a stale order without calling line interceptors. */
@Injectable()
export class LeadOrderSaveGuard implements EntitySubscriberInterface<Order>, OnModuleInit {
    constructor(private connection: TransactionalConnection) {}
    onModuleInit() {
        this.connection.rawConnection.subscribers.push(this);
    }
    listenTo() {
        return Order;
    }
    async beforeUpdate(event: UpdateEvent<Order>) {
        if (event.entity?.id == null) return;
        const query = event.manager
            .getRepository(Order)
            .createQueryBuilder('order')
            .where('order.id = :id', { id: event.entity.id });
        if (event.queryRunner.isTransactionActive) query.setLock('pessimistic_write');
        const persisted = await query.getOne();
        if (persisted?.state === 'LeadSubmitted' && !persisted.active)
            throw new LeadInputError('LEAD_ALREADY_SUBMITTED');
    }
}
