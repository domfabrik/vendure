import {
    Order,
    OrderInterceptor,
    RequestContext,
    WillAddItemToOrderInput,
    WillAdjustOrderLineInput,
} from '@vendure/core';

export const PRICE_NOT_SPECIFIED_ORDER_ERROR = 'Цена для этого товара не указана';

type PriceNotSpecifiedCustomFields = {
    priceNotSpecified?: boolean | null;
};

export class PriceNotSpecifiedOrderInterceptor implements OrderInterceptor {
    willAddItemToOrder(_ctx: RequestContext, _order: Order, input: WillAddItemToOrderInput): void | string {
        if (isPriceNotSpecified(input.productVariant.customFields)) {
            return PRICE_NOT_SPECIFIED_ORDER_ERROR;
        }
    }

    willAdjustOrderLine(_ctx: RequestContext, _order: Order, input: WillAdjustOrderLineInput): void | string {
        // Quantity zero must remain available as an escape hatch for a stale cart.
        if (input.quantity > 0 && isPriceNotSpecified(input.orderLine.productVariant.customFields)) {
            return PRICE_NOT_SPECIFIED_ORDER_ERROR;
        }
    }
}

function isPriceNotSpecified(customFields: unknown): boolean {
    return (customFields as PriceNotSpecifiedCustomFields | undefined)?.priceNotSpecified === true;
}
