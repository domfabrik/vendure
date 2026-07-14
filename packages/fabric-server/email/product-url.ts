export function getStorefrontOrigin(value: string | undefined): string | null {
    const origin = value
        ?.split(',')
        .map(item => item.trim())
        .find(Boolean);

    if (!origin) {
        return null;
    }

    try {
        return new URL(origin).origin;
    } catch {
        return null;
    }
}

export function getProductUrl(
    storefrontOrigin: string | null,
    slug: string | null | undefined,
): string | null {
    if (!storefrontOrigin || !slug?.trim()) {
        return null;
    }

    return `${storefrontOrigin}/products/${encodeURIComponent(slug.trim())}`;
}
