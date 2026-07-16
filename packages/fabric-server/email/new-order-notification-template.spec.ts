import { readFileSync } from 'fs';
import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getDisplayProductName, getDisplaySku } from './order-line-display';
import { getProductUrl, getStorefrontOrigin } from './product-url';

describe('product URL for new order notification', () => {
    it('uses the first configured storefront origin and product slug', () => {
        const origin = getStorefrontOrigin('https://shop.domfabric.ru, https://admin.domfabric.ru');

        expect(getProductUrl(origin, 'кресло velvet')).toBe(
            'https://shop.domfabric.ru/products/%D0%BA%D1%80%D0%B5%D1%81%D0%BB%D0%BE%20velvet',
        );
    });

    it('does not create a product URL without an origin or slug', () => {
        expect(getStorefrontOrigin('not a URL')).toBeNull();
        expect(getProductUrl('https://shop.domfabric.ru', '  ')).toBeNull();
        expect(getProductUrl(null, 'chair')).toBeNull();
    });
});

describe('new order notification template', () => {
    it('renders a separate paragraph for each line rather than an order table', () => {
        const template = readFileSync(
            path.join(__dirname, 'templates/new-order-notification/body.hbs'),
            'utf8',
        );

        const orderContents = template.slice(template.indexOf('Состав заказа'), template.indexOf('Платежи'));
        expect(orderContents).not.toContain('<mj-table');
        const mjml = Handlebars.compile(template)({
            order: { code: 'T-1', state: 'ArrangingPayment', totalQuantity: 1 },
            display: {
                createdAt: '14 июля 2026 г.',
                totals: { subTotalWithTax: '1 814 ₽', totalWithTax: '1 814 ₽' },
                lines: [
                    {
                        position: 1,
                        sku: '139808',
                        productName: 'Крем. Золото. Мрамор',
                        productVariantName: 'Черный 48 мм',
                        productUrl: 'https://shop.domfabric.ru/products/krem-zoloto-mramor',
                        quantity: 2,
                        discountedUnitPriceWithTax: '1 814 ₽',
                    },
                    {
                        position: 2,
                        sku: null,
                        productName: 'Тумбочка Белая',
                        productVariantName: 'Белая',
                        productUrl: null,
                        quantity: 1,
                        discountedUnitPriceWithTax: '2 000 ₽',
                    },
                ],
                shippingLines: [],
                surcharges: [],
                discounts: [],
                payments: [],
            },
        });
        const result = mjml2html(mjml);
        const renderedText = result.html.replace(/\s+/g, ' ');

        expect(result.errors).toEqual([]);
        expect(renderedText).toContain('Позиция 1 · SKU: 139808 · Крем. Золото. Мрамор');
        expect(renderedText).toContain('Позиция 2 · Тумбочка Белая');
        expect(renderedText).not.toContain('SKU: -');
        expect(renderedText).toContain('Вариант: Черный 48 мм');
        expect(renderedText).toContain('Количество: 2 шт.');
        expect(renderedText).toContain('Количество: 1 шт.');
        expect(renderedText).toContain('Цена в магазине: 1 814 ₽');
        expect(result.html).toContain('href="https://shop.domfabric.ru/products/krem-zoloto-mramor"');
    });
});

describe('order line display values', () => {
    it('uses the variant name as a product-name fallback and hides a slug used as a technical SKU', () => {
        expect(
            getDisplaySku('tumba-detskaya-natali-belyj-glyanec', 'tumba-detskaya-natali-belyj-glyanec'),
        ).toBeNull();
        expect(getDisplaySku('139229', '139229')).toBe('139229');
        expect(getDisplayProductName(undefined, 'Тумба детская Натали белый глянец')).toBe(
            'Тумба детская Натали белый глянец',
        );
    });
});
