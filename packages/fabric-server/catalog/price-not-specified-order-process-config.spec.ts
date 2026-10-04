import 'reflect-metadata';

import {
    ConfigService,
    defaultOrderProcess,
    Injector,
    Order,
    OrderLine,
    OrderStateMachine,
    preBootstrapConfig,
    ProductVariant,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lead/lead-submission.entity', () => ({
    LeadSubmission: class LeadSubmission {},
}));

import { fabricServerConfig } from '../vendure-config';
import { PRICE_NOT_SPECIFIED_ORDER_ERROR } from './price-not-specified-order.interceptor';
import { PriceNotSpecifiedOrderProcess } from './price-not-specified-order.process';

describe('Fabric final order-process configuration', () => {
    let processes: NonNullable<NonNullable<typeof fabricServerConfig.orderOptions>['process']>;
    let stateMachine: OrderStateMachine;
    let guard: PriceNotSpecifiedOrderProcess;

    beforeAll(async () => {
        const finalConfig = await preBootstrapConfig(fabricServerConfig);
        processes = finalConfig.orderOptions.process;
        guard = processes.find(
            process => process instanceof PriceNotSpecifiedOrderProcess,
        ) as PriceNotSpecifiedOrderProcess;
        stateMachine = new OrderStateMachine({
            orderOptions: finalConfig.orderOptions,
        } as ConfigService);
    });

    it('retains the default graph and composes the lead and missing-price processes', () => {
        expect(processes[0].transitions).toEqual(defaultOrderProcess.transitions);
        expect(guard).toBeInstanceOf(PriceNotSpecifiedOrderProcess);
        expect(
            processes.some(process => process.transitions?.AddingItems?.to.includes('LeadSubmitted')),
        ).toBe(true);

        expect(stateMachine.canTransition('Created', 'AddingItems')).toBe(true);
        expect(stateMachine.canTransition('AddingItems', 'ArrangingPayment')).toBe(true);
        expect(stateMachine.canTransition('AddingItems', 'LeadSubmitted')).toBe(true);
    });

    it('runs the fresh missing-price guard inside the composed state machine', async () => {
        const setLock = initializeGuardWithFreshFlag(guard, true);
        const order = {
            id: 'stale-order',
            state: 'AddingItems',
            lines: [],
            payments: [],
            active: true,
        } as unknown as Order;

        await expect(stateMachine.transition({} as RequestContext, order, 'LeadSubmitted')).rejects.toThrow(
            PRICE_NOT_SPECIFIED_ORDER_ERROR,
        );
        expect(order.state).toBe('AddingItems');
        expect(setLock).toHaveBeenCalledWith('pessimistic_read');
    });

    it('blocks active standard order placement after a price becomes unspecified', async () => {
        const setLock = initializeGuardWithFreshFlag(guard, true);
        const order = {
            id: 'active-payment-order',
            state: 'ArrangingPayment',
            lines: [],
            payments: [{ state: 'Settled', amount: 10_000, refunds: [] }],
            totalWithTax: 10_000,
            active: true,
        } as unknown as Order;

        await expect(stateMachine.transition({} as RequestContext, order, 'PaymentSettled')).rejects.toThrow(
            PRICE_NOT_SPECIFIED_ORDER_ERROR,
        );
        expect(order.state).toBe('ArrangingPayment');
        expect(setLock).toHaveBeenCalledWith('pessimistic_read');
    });
});

function initializeGuardWithFreshFlag(guard: PriceNotSpecifiedOrderProcess, flag: boolean) {
    const setLock = vi.fn().mockReturnThis();
    const queryBuilder = {
        innerJoinAndSelect: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        setLock,
        getMany: vi.fn(() =>
            Promise.resolve([
                {
                    productVariant: {
                        customFields: { priceNotSpecified: flag },
                    } as unknown as ProductVariant,
                } as OrderLine,
            ]),
        ),
    };
    const connection = {
        getRepository: vi.fn(() => ({
            createQueryBuilder: vi.fn(() => queryBuilder),
        })),
    } as unknown as TransactionalConnection;
    guard.init({ get: vi.fn(() => connection) } as unknown as Injector);
    return setLock;
}
