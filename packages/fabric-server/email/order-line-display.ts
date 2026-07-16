export function getDisplayProductName(
    productName: string | null | undefined,
    productVariantName: string | null | undefined,
): string {
    return productName ?? productVariantName ?? '-';
}

export function getDisplaySku(
    sku: string | null | undefined,
    productSlug: string | null | undefined,
): string | null {
    if (!sku?.trim()) {
        return null;
    }

    const normalizedSku = sku.trim();
    const normalizedSlug = productSlug?.trim();

    // Era/Fortuna imports use the product URL slug as a fallback SKU when the supplier
    // provides no article. Do not present this technical identifier as an SKU in emails.
    if (
        normalizedSlug &&
        normalizedSku.toLocaleLowerCase() === normalizedSlug.toLocaleLowerCase() &&
        /[a-z]/i.test(normalizedSku) &&
        normalizedSku.includes('-')
    ) {
        return null;
    }

    return normalizedSku;
}
