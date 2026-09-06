import { EntityHydrator, OrderEvent } from '@vendure/core';
import {
    EmailEventListener,
    shippingLinesWithMethod,
    transformOrderLineAssetUrls,
} from '@vendure/email-plugin';

import { getDisplayProductName, getDisplayProductSlug, getDisplaySku } from './order-line-display';
import { getProductUrl, getStorefrontOrigin } from './product-url';

const ORDER_NOTIFICATION_LOCALE = 'ru-RU';
const ORDER_NOTIFICATION_TIME_ZONE = 'Europe/Moscow';
const ORDER_NOTIFICATION_CURRENCY = 'RUB';

export function createNewOrderNotificationHandler(primaryRecipient: string, ccRecipients: string[]) {
    return new EmailEventListener('new-order-notification')
        .on(OrderEvent)
        .filter(
            event =>
                event.type === 'updated' &&
                hasRecipientContactFields(event.input) &&
                event.order.lines.length > 0,
        )
        .loadData(async ({ event, injector }) => {
            const entityHydrator = injector.get(EntityHydrator);
            await entityHydrator.hydrate(event.ctx, event.order, {
                relations: [
                    'customer',
                    'lines.featuredAsset',
                    'lines.productVariant',
                    'lines.productVariant.product',
                    'lines.productVariant.product.translations',
                    'shippingLines.shippingMethod',
                    'payments',
                    'surcharges',
                ],
            });

            transformOrderLineAssetUrls(event.ctx, event.order, injector);

            return {
                display: toDisplayOrder(event.order, getStorefrontOrigin(process.env.STOREFRONT_ORIGIN)),
            };
        })
        .setRecipient(() => primaryRecipient)
        .setOptionalAddressFields(() => ({
            cc: ccRecipients.length > 0 ? ccRecipients.join(', ') : undefined,
        }))
        .setMetadata(event => ({
            emailType: 'new-order-notification',
            orderId: event.order.id,
            orderCode: event.order.code,
        }))
        .setFrom('{{ fromAddress }}')
        .setSubject('Новый заказ #{{ order.code }}')
        .setTemplateVars(event => ({
            order: event.order,
            display: event.data.display,
            shippingLines: shippingLinesWithMethod(event.order),
        }));
}

export function toDisplayOrder(
    order: OrderEvent['order'],
    storefrontOrigin: string | null = null,
    currencyCode = ORDER_NOTIFICATION_CURRENCY,
) {
    const money = (value: number) => formatMoneyValue(value, currencyCode);
    return {
        locale: ORDER_NOTIFICATION_LOCALE,
        currencyCode,
        orderPlacedAt: formatDateTime(order.orderPlacedAt),
        createdAt: formatDateTime(order.createdAt),
        updatedAt: formatDateTime(order.updatedAt),
        totals: {
            subTotalWithTax: money(order.subTotalWithTax),
            totalWithTax: money(order.totalWithTax),
            shipping: money(order.shippingWithTax),
        },
        lines: (order.lines ?? []).map((line, index) => {
            const productVariant = line.productVariant;
            const product = productVariant?.product;
            const productSlug = getDisplayProductSlug(product?.slug, product?.translations);

            return {
                position: index + 1,
                sku: getDisplaySku(productVariant?.sku, productSlug),
                productVariantName: productVariant?.name ?? '-',
                productName: getDisplayProductName(
                    product?.name,
                    product?.translations,
                    productVariant?.name,
                ),
                productUrl: getProductUrl(storefrontOrigin, productSlug),
                quantity: line.quantity,
                discountedUnitPriceWithTax: money(line.discountedUnitPriceWithTax),
                discountedLinePriceWithTax: money(line.discountedLinePriceWithTax),
            };
        }),
        shippingLines: (order.shippingLines ?? []).map(line => ({
            name: line.shippingMethod?.name ?? null,
            priceWithTax: money(line.priceWithTax),
        })),
        surcharges: (order.surcharges ?? []).map(surcharge => ({
            description: surcharge.description,
            priceWithTax: money((surcharge as { priceWithTax?: number }).priceWithTax ?? surcharge.price),
        })),
        discounts: (order.discounts ?? []).map(discount => ({
            description: discount.description,
            amountWithTax: money(discount.amountWithTax),
        })),
        payments: (order.payments ?? []).map(payment => ({
            method: payment.method,
            state: payment.state,
            amount: money(payment.amount),
            transactionId: payment.transactionId ?? null,
            createdAt: formatDateTime(payment.createdAt),
            updatedAt: formatDateTime(payment.updatedAt),
        })),
    };
}

function formatMoneyValue(value: number, currency = ORDER_NOTIFICATION_CURRENCY): string {
    return new Intl.NumberFormat(ORDER_NOTIFICATION_LOCALE, {
        style: 'currency',
        currency,
        currencyDisplay: 'symbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(value / 100);
}

function formatDateTime(value?: Date | null): string | null {
    if (!value) {
        return null;
    }

    return new Intl.DateTimeFormat(ORDER_NOTIFICATION_LOCALE, {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: ORDER_NOTIFICATION_TIME_ZONE,
    }).format(value);
}

function hasRecipientContactFields(
    input: OrderEvent['input'],
): input is { customFields: { recipientFullName?: string; recipientPhoneNumber?: string } } {
    if (!input || typeof input !== 'object' || !('customFields' in input)) {
        return false;
    }

    const customFields = input.customFields;

    if (!customFields || typeof customFields !== 'object') {
        return false;
    }

    return (
        hasNonEmptyString(customFields.recipientFullName) ||
        hasNonEmptyString(customFields.recipientPhoneNumber)
    );
}

function hasNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}
