export function getDisplayProductName(
    productName: string | null | undefined,
    productTranslations: ReadonlyArray<{ languageCode?: string; name?: string | null }> | null | undefined,
    productVariantName: string | null | undefined,
): string {
    return (
        getNonEmptyValue(productName) ??
        productTranslations
            ?.filter(translation => translation.languageCode === 'ru')
            .map(translation => getNonEmptyValue(translation.name))
            .find((name): name is string => name != null) ??
        productTranslations
            ?.map(translation => getNonEmptyValue(translation.name))
            .find((name): name is string => name != null) ??
        getNonEmptyValue(productVariantName) ??
        '-'
    );
}

export function getDisplayProductSlug(
    productSlug: string | null | undefined,
    productTranslations: ReadonlyArray<{ languageCode?: string; slug?: string | null }> | null | undefined,
): string | null {
    return (
        getNonEmptyValue(productSlug) ??
        productTranslations
            ?.filter(translation => translation.languageCode === 'ru')
            .map(translation => getNonEmptyValue(translation.slug))
            .find((slug): slug is string => slug != null) ??
        productTranslations
            ?.map(translation => getNonEmptyValue(translation.slug))
            .find((slug): slug is string => slug != null) ??
        null
    );
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

function getNonEmptyValue(value: string | null | undefined): string | null {
    return value?.trim() || null;
}
