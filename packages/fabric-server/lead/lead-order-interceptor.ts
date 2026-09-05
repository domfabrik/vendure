import { Injector, Order, OrderInterceptor, RequestContext, TransactionalConnection } from '@vendure/core';

import { LeadInputError } from './lead-order.service';

/** Core reads cart state before its write hooks. Recheck under a lock to close the concurrent-submit race. */
export class LeadOrderInterceptor implements OrderInterceptor {
    private connection: TransactionalConnection;
    init(injector: Injector) {
        this.connection = injector.get(TransactionalConnection);
    }
    willAddItemToOrder(ctx: RequestContext, order: Order) {
        return this.check(ctx, order);
    }
    willAdjustOrderLine(ctx: RequestContext, order: Order) {
        return this.check(ctx, order);
    }
    willRemoveItemFromOrder(ctx: RequestContext, order: Order) {
        return this.check(ctx, order);
    }
    private async check(ctx: RequestContext, order: Order) {
        const repository = this.connection.getRepository(ctx, Order);
        const query = repository.createQueryBuilder('order').where('order.id = :id', { id: order.id });
        // Public service calls can run outside a transaction. Shop mutations and submitLeadOrder do use one.
        if (repository.manager.queryRunner?.isTransactionActive) query.setLock('pessimistic_write');
        const current = await query.getOneOrFail();
        // Returning an interceptor error is insufficient: addItemsToOrder still recalculates/saves its stale Order.
        if (current.state === 'LeadSubmitted') throw new LeadInputError('LEAD_ALREADY_SUBMITTED');
    }
}
