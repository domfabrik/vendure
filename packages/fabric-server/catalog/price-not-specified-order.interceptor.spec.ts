import {
    Injector,
    Order,
    OrderLine,
    ProductVariant,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';

import { aridaCatalogCustomFields } from './custom-fields';
import {
    PRICE_NOT_SPECIFIED_ORDER_ERROR,
    PriceNotSpecifiedOrderInterceptor,
} from './price-not-specified-order.interceptor';
import { PriceNotSpecifiedOrderProcess } from './price-not-specified-order.process';

describe('PriceNotSpecifiedOrderInterceptor', () => {
    const interceptor = new PriceNotSpecifiedOrderInterceptor();
    const requestContext = {} as RequestContext;
    const order = {} as Order;

    it('declares a nullable public ProductVariant custom field', () => {
        const field = aridaCatalogCustomFields.ProductVariant?.find(
            candidate => candidate.name === 'priceNotSpecified',
        );

        expect(field).toMatchObject({
            name: 'priceNotSpecified',
            type: 'boolean',
            nullable: true,
            public: true,
        });
    });

    it.each([undefined, null, false])('allows ordinary add operations for %s', priceNotSpecified => {
        expect(
            interceptor.willAddItemToOrder(requestContext, order, {
                productVariant: variant(priceNotSpecified),
                quantity: 1,
            }),
        ).toBeUndefined();
    });

    it('rejects direct and batched add operations for a missing-price variant', () => {
        // Vendure invokes this callback for each item in addItemToOrder and addItemsToOrder.
        expect(
            interceptor.willAddItemToOrder(requestContext, order, {
                productVariant: variant(true),
                quantity: 1,
            }),
        ).toBe(PRICE_NOT_SPECIFIED_ORDER_ERROR);
    });

    it('rejects a positive adjustment but allows removing a stale line with quantity zero', () => {
        const orderLine = { productVariant: variant(true) } as OrderLine;

        expect(interceptor.willAdjustOrderLine(requestContext, order, { orderLine, quantity: 2 })).toBe(
            PRICE_NOT_SPECIFIED_ORDER_ERROR,
        );
        expect(
            interceptor.willAdjustOrderLine(requestContext, order, { orderLine, quantity: 0 }),
        ).toBeUndefined();
    });

    it('allows a missing-price variant after the flag is cleared', () => {
        const productVariant = variant(true);
        productVariant.customFields = { priceNotSpecified: false } as ProductVariant['customFields'];

        expect(
            interceptor.willAddItemToOrder(requestContext, order, {
                productVariant,
                quantity: 1,
            }),
        ).toBeUndefined();
    });
});

describe('PriceNotSpecifiedOrderProcess', () => {
    const requestContext = {} as RequestContext;

    it.each(['ArrangingPayment', 'LeadSubmitted'] as const)(
        'rejects %s from fresh variant state after a stale priced line was added',
        async targetState => {
            let freshPriceNotSpecified = false;
            const { process, getRepository, setLock } = makeOrderProcess(() => freshPriceNotSpecified);
            const staleOrder = {
                id: 'order-1',
                lines: [{ productVariant: variant(false) }],
            } as unknown as Order;

            freshPriceNotSpecified = true;
            await expect(
                process.onTransitionStart?.('AddingItems', targetState, {
                    ctx: requestContext,
                    order: staleOrder,
                }),
            ).resolves.toBe(PRICE_NOT_SPECIFIED_ORDER_ERROR);
            expect(getRepository).toHaveBeenCalledWith(requestContext, OrderLine);
            expect(setLock).toHaveBeenCalledWith('pessimistic_read');
        },
    );

    it('allows purchase after the fresh missing-price flag is cleared', async () => {
        let freshPriceNotSpecified = true;
        const { process } = makeOrderProcess(() => freshPriceNotSpecified);
        const order = { id: 'order-1' } as Order;

        freshPriceNotSpecified = false;
        await expect(
            process.onTransitionStart?.('AddingItems', 'ArrangingPayment', {
                ctx: requestContext,
                order,
            }),
        ).resolves.toBeUndefined();
    });

    it.each(['PaymentAuthorized', 'PaymentSettled'] as const)(
        'rejects active order placement through %s when the fresh flag is set',
        async targetState => {
            const { process, setLock } = makeOrderProcess(() => true);

            await expect(
                process.onTransitionStart?.('ArrangingPayment', targetState, {
                    ctx: requestContext,
                    order: { id: 'active-order', active: true } as Order,
                }),
            ).resolves.toBe(PRICE_NOT_SPECIFIED_ORDER_ERROR);
            expect(setLock).toHaveBeenCalledWith('pessimistic_read');
        },
    );

    it('does not query catalog state for a non-purchase transition', async () => {
        const { process, getRepository } = makeOrderProcess(() => true);

        await expect(
            process.onTransitionStart?.('AddingItems', 'Cancelled', {
                ctx: requestContext,
                order: { id: 'order-1' } as Order,
            }),
        ).resolves.toBeUndefined();
        expect(getRepository).not.toHaveBeenCalled();
    });

    it.each(['PaymentAuthorized', 'PaymentSettled'] as const)(
        'does not block the %s lifecycle of an already placed order',
        async targetState => {
            const { process, getRepository } = makeOrderProcess(() => true);

            await expect(
                process.onTransitionStart?.('ArrangingPayment', targetState, {
                    ctx: requestContext,
                    order: { id: 'placed-order', active: false } as Order,
                }),
            ).resolves.toBeUndefined();
            expect(getRepository).not.toHaveBeenCalled();
        },
    );
});

function variant(priceNotSpecified: boolean | null | undefined): ProductVariant {
    return {
        customFields: { priceNotSpecified },
    } as unknown as ProductVariant;
}

function makeOrderProcess(readFlag: () => boolean) {
    const setLock = vi.fn().mockReturnThis();
    const queryBuilder = {
        innerJoinAndSelect: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        setLock,
        getMany: vi.fn(() =>
            Promise.resolve([{ productVariant: variant(readFlag()) } as unknown as OrderLine]),
        ),
    };
    const getRepository = vi.fn(() => ({
        createQueryBuilder: vi.fn(() => queryBuilder),
    }));
    const connection = { getRepository } as unknown as TransactionalConnection;
    const process = new PriceNotSpecifiedOrderProcess();
    process.init({ get: vi.fn(() => connection) } as unknown as Injector);
    return { process, getRepository, setLock };
}
