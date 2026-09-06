import { Order } from '@vendure/core';
import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { toDisplayOrder } from '../email/new-order-notification-handler';
import { getStorefrontOrigin } from '../email/product-url';

let template: Handlebars.TemplateDelegate | undefined;
/** Freeze the same operator template used by legacy checkout, including product names and links. */
export function leadEmailSnapshot(order: Order) {
    template ??= Handlebars.compile(
        readFileSync(
            path.join(
                process.cwd(),
                'packages/fabric-server/email/templates/new-order-notification/body.hbs',
            ),
            'utf8',
        ),
    );
    const mjml = template({
        order: {
            code: order.code,
            state: order.state,
            totalQuantity: order.totalQuantity,
            couponCodes: order.couponCodes,
            customer: order.customer
                ? {
                      firstName: order.customer.firstName,
                      lastName: order.customer.lastName,
                      emailAddress: order.customer.emailAddress,
                      phoneNumber: order.customer.phoneNumber,
                  }
                : undefined,
            customFields: { ...order.customFields },
        },
        display: toDisplayOrder(
            order,
            getStorefrontOrigin(process.env.STOREFRONT_ORIGIN),
            order.currencyCode,
        ),
    });
    return mjml2html(mjml, { validationLevel: 'strict' }).html;
}
