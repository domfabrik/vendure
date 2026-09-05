import { Injectable } from '@nestjs/common';
import {
    ConfigService,
    Order,
    OrderService,
    ProductVariant,
    RequestContext,
    Session,
    TransactionalConnection,
    UserInputError,
    isGraphQlErrorResult,
} from '@vendure/core';
import { createHash, timingSafeEqual } from 'node:crypto';

import { leadEmailSnapshot } from './lead-email-snapshot';
import { LeadReceipt, LeadSubmission } from './lead-submission.entity';

export const leadTransitions = new WeakSet<RequestContext>();
export interface SubmitLeadInput {
    sessionCapability: string;
    submissionToken: string;
    items: Array<{ productVariantId: string; quantity: number }>;
    contact: { fullName: string; phone: string };
}
export class LeadInputError extends UserInputError {
    constructor(code: string) {
        super(code);
    }
}
export function digest(value: string) {
    return createHash('sha256').update(value).digest('hex');
}

export function normalizeLead(input: SubmitLeadInput) {
    if (
        !input ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            input.submissionToken ?? '',
        ) ||
        !Array.isArray(input.items) ||
        input.items.length < 1 ||
        input.items.length > 50
    ) {
        throw new LeadInputError('LEAD_INVALID_INPUT');
    }
    const name = input.contact?.fullName;
    const phone = input.contact?.phone;
    if (
        typeof name !== 'string' ||
        name.length > 200 ||
        typeof phone !== 'string' ||
        phone.length > 40 ||
        /[\x00-\x1f\x7f]/.test(name + phone)
    )
        throw new LeadInputError('LEAD_INVALID_INPUT');
    const contact = { fullName: name.trim().replace(/\s+/g, ' '), phone: phone.replace(/[\s()-]/g, '') };
    if (contact.fullName.length < 2 || !/^\+?\d{7,15}$/.test(contact.phone))
        throw new LeadInputError('LEAD_INVALID_INPUT');
    const items = input.items
        .map(item => {
            if (
                !item ||
                !['string', 'number'].includes(typeof item.productVariantId) ||
                !/^[1-9]\d{0,9}$/.test(String(item.productVariantId)) ||
                !Number.isInteger(item.quantity) ||
                item.quantity < 1 ||
                item.quantity > 100
            )
                throw new LeadInputError('LEAD_INVALID_INPUT');
            return { productVariantId: String(item.productVariantId), quantity: item.quantity };
        })
        .sort((a, b) => a.productVariantId.localeCompare(b.productVariantId));
    if (
        new Set(items.map(i => i.productVariantId)).size !== items.length ||
        items.reduce((n, i) => n + i.quantity, 0) > 500
    ) {
        throw new LeadInputError('LEAD_INVALID_INPUT');
    }
    return { items, contact };
}

@Injectable()
export class LeadOrderService {
    constructor(
        private connection: TransactionalConnection,
        private orders: OrderService,
        private config: ConfigService,
    ) {}

    prepare(ctx: RequestContext) {
        if (!ctx.session) throw new LeadInputError('LEAD_SESSION_REQUIRED');
        return { sessionCapability: digest(`fabric-lead-v1:${ctx.channelId}:${ctx.session.token}`) };
    }

    async submit(ctx: RequestContext, input: SubmitLeadInput): Promise<LeadReceipt> {
        const activeSession = ctx.session;
        if (!activeSession) throw new LeadInputError('LEAD_SESSION_REQUIRED');
        const payload = normalizeLead(input);
        const expected = this.prepare(ctx).sessionCapability;
        if (
            typeof input.sessionCapability !== 'string' ||
            !/^[0-9a-f]{64}$/.test(input.sessionCapability) ||
            !timingSafeEqual(Buffer.from(expected), Buffer.from(input.sessionCapability))
        ) {
            throw new LeadInputError('LEAD_SESSION_REQUIRED');
        }
        try {
            const committedReceipt = await this.connection.withTransaction(ctx, async tx => {
                // Serialize every token of this session across all app instances. Never trust cached activeOrderId.
                const session = await this.connection
                    .getRepository(tx, Session)
                    .createQueryBuilder('session')
                    .where('session.id = :id', { id: activeSession.id })
                    .setLock('pessimistic_write')
                    .getOne();
                if (!session || session.invalidated || session.expires <= new Date())
                    throw new LeadInputError('LEAD_SESSION_REQUIRED');
                const repository = this.connection.getRepository(tx, LeadSubmission);
                const scope = {
                    channelId: String(ctx.channelId),
                    sessionId: String(session.id),
                    tokenHash: digest(input.submissionToken.toLowerCase()),
                };
                const fingerprint = digest(JSON.stringify(payload));
                const previous = await repository.findOne({ where: scope });
                if (previous) {
                    if (previous.fingerprint !== fingerprint) throw new LeadInputError('LEAD_TOKEN_CONFLICT');
                    return previous.receipt;
                }
                const available = await this.connection
                    .getRepository(tx, ProductVariant)
                    .createQueryBuilder('variant')
                    .innerJoin('variant.channels', 'channel', 'channel.id = :channelId', {
                        channelId: ctx.channelId,
                    })
                    .innerJoin(
                        'variant.product',
                        'product',
                        'product.enabled = true AND product.deletedAt IS NULL',
                    )
                    .where('variant.id IN (:...ids)', {
                        ids: payload.items.map(item => item.productVariantId),
                    })
                    .andWhere('variant.enabled = true AND variant.deletedAt IS NULL')
                    .getCount();
                if (available !== payload.items.length) throw new LeadInputError('LEAD_ITEMS_UNAVAILABLE');
                let existing = session.activeOrderId
                    ? await this.connection.getRepository(tx, Order).findOne({
                          where: { id: session.activeOrderId },
                          relations: ['channels'],
                      })
                    : undefined;
                const isOwnCart = (candidate: Order) => {
                    const origin = (candidate.customFields as { leadOriginChannel?: string })
                        .leadOriginChannel;
                    // Vendure also assigns nondefault-channel orders to the default channel. Membership alone is not provenance.
                    return (
                        candidate.active &&
                        (origin
                            ? origin === String(ctx.channelId)
                            : candidate.channels.length === 1 &&
                              String(candidate.channels[0].id) === String(ctx.channelId))
                    );
                };
                if (existing && !isOwnCart(existing)) existing = undefined;
                if (!existing && ctx.activeUserId) {
                    const candidates = await this.connection
                        .getRepository(tx, Order)
                        .createQueryBuilder('order')
                        .leftJoinAndSelect('order.channels', 'channels')
                        .innerJoin('order.customer', 'customer')
                        .innerJoin('customer.user', 'user')
                        .where('order.active = true AND user.id = :userId', { userId: ctx.activeUserId })
                        .orderBy('order.createdAt', 'DESC')
                        .getMany();
                    existing = candidates.find(isOwnCart);
                }
                let order: Order;
                if (existing) {
                    const locked = await this.connection
                        .getRepository(tx, Order)
                        .createQueryBuilder('order')
                        .where('order.id = :id', { id: existing.id })
                        .setLock('pessimistic_write')
                        .getOneOrFail();
                    if (!locked.active || locked.state !== 'AddingItems')
                        throw new LeadInputError('LEAD_CART_NOT_EDITABLE');
                    const emptied = await this.orders.removeAllItemsFromOrder(tx, locked.id);
                    if (isGraphQlErrorResult(emptied)) throw new LeadInputError('LEAD_CART_NOT_EDITABLE');
                    order = emptied;
                } else order = await this.orders.create(tx, ctx.activeUserId);
                const added = await this.orders.addItemsToOrder(tx, order.id, payload.items);
                if (added.errorResults.length) throw new LeadInputError('LEAD_ITEMS_UNAVAILABLE');
                order = added.order;
                await this.checkpoint('lines', tx);
                // Contact fields are scalar Fabric fields. Do not emit the legacy broad OrderEvent:
                // this flow owns its durable outbox, while old storefront callers keep their existing notification.
                order.customFields = {
                    ...order.customFields,
                    recipientFullName: payload.contact.fullName,
                    recipientPhoneNumber: payload.contact.phone,
                } as any;
                await this.connection.getRepository(tx, Order).save(order);
                await this.checkpoint('contact', tx);
                leadTransitions.add(tx);
                try {
                    const finalized = await this.orders.transitionToState(tx, order.id, 'LeadSubmitted');
                    if (isGraphQlErrorResult(finalized)) throw new LeadInputError('LEAD_CANNOT_FINALIZE');
                    order = finalized;
                } finally {
                    leadTransitions.delete(tx);
                }
                await this.checkpoint('finalize', tx);
                if (String(session.activeOrderId) === String(order.id)) {
                    await this.connection
                        .getRepository(tx, Session)
                        .update(session.id, { activeOrderId: null as any });
                }
                const receipt: LeadReceipt = {
                    orderId: String(order.id),
                    code: order.code,
                    currencyCode: order.currencyCode,
                    totalWithTax: order.totalWithTax,
                    lines: order.lines.map(line => ({
                        productVariantId: String(line.productVariantId),
                        quantity: line.quantity,
                        unitPriceWithTax: line.discountedUnitPriceWithTax,
                        linePriceWithTax: line.discountedLinePriceWithTax,
                    })),
                };
                const hydrated = await this.orders.findOne(tx, order.id, [
                    'customer',
                    'lines.productVariant',
                    'lines.productVariant.product',
                    'lines.productVariant.product.translations',
                    'shippingLines.shippingMethod',
                    'payments',
                    'surcharges',
                ]);
                if (!hydrated) throw new LeadInputError('LEAD_CANNOT_FINALIZE');
                await repository.save(
                    new LeadSubmission({
                        ...scope,
                        fingerprint,
                        orderId: String(order.id),
                        receipt,
                        contact: payload.contact,
                        notificationBody: leadEmailSnapshot(hydrated),
                        notificationState: 'pending',
                        attemptedAt: null,
                    }),
                );
                return receipt;
            });
            // Invalidate only after commit. Other instances' stale cache entries also reject inactive carts in Vendure's strategy.
            try {
                await this.config.authOptions.sessionCacheStrategy.delete(activeSession.token);
            } catch {
                /* DB remains authoritative. */
            }
            return committedReceipt;
        } catch (error) {
            if (error instanceof LeadInputError) throw error;
            // Do not expose ORM SQL, inventory details, contact fields or credentials in GraphQL errors.
            throw new LeadInputError('LEAD_SUBMISSION_FAILED');
        }
    }

    /** Fault injection seam for isolated integration tests; never reachable from GraphQL or environment variables. */
    protected checkpoint(_point: 'lines' | 'contact' | 'finalize', _ctx: RequestContext): Promise<void> {
        return Promise.resolve();
    }
}
