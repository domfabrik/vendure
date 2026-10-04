import {
    Injector,
    OrderLine,
    OrderProcess,
    OrderState,
    OrderTransitionData,
    TransactionalConnection,
} from '@vendure/core';

import { PRICE_NOT_SPECIFIED_ORDER_ERROR } from './price-not-specified-order.interceptor';

const PRE_PAYMENT_TRANSITIONS = new Set<OrderState>(['ArrangingPayment', 'LeadSubmitted']);
const PLACEMENT_TRANSITIONS = new Set<OrderState>(['PaymentAuthorized', 'PaymentSettled']);

type PriceNotSpecifiedCustomFields = {
    priceNotSpecified?: boolean | null;
};

export class PriceNotSpecifiedOrderProcess implements OrderProcess<'LeadSubmitted'> {
    private connection!: TransactionalConnection;

    init(injector: Injector): void {
        this.connection = injector.get(TransactionalConnection);
    }

    async onTransitionStart(
        _fromState: OrderState,
        toState: OrderState,
        { ctx, order }: OrderTransitionData,
    ): Promise<void | string> {
        const entersPurchaseFlow = PRE_PAYMENT_TRANSITIONS.has(toState);
        const placesActiveOrder = order.active && PLACEMENT_TRANSITIONS.has(toState);
        if (!entersPurchaseFlow && !placesActiveOrder) {
            return;
        }

        // Query through the request transaction instead of trusting relations loaded before
        // a catalog update. The shared lock keeps the checked variant rows stable until the
        // transition transaction completes.
        const lines = await this.connection
            .getRepository(ctx, OrderLine)
            .createQueryBuilder('line')
            .innerJoinAndSelect('line.productVariant', 'variant')
            .where('line.orderId = :orderId', { orderId: order.id })
            .setLock('pessimistic_read')
            .getMany();

        const containsMissingPrice = lines.some(
            line =>
                (line.productVariant.customFields as PriceNotSpecifiedCustomFields | undefined)
                    ?.priceNotSpecified === true,
        );
        if (containsMissingPrice) {
            return PRICE_NOT_SPECIFIED_ORDER_ERROR;
        }
    }
}
