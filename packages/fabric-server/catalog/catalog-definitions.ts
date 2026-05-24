import { LanguageCode } from '@vendure/core';

type BaseTranslationDefinition = {
    languageCode: LanguageCode;
    name: string;
};

type CollectionTranslationDefinition = BaseTranslationDefinition & {
    description: string;
    slug: string;
};

type FacetTranslationDefinition = BaseTranslationDefinition;

export type CollectionDefinition = {
    slug: string;
    name: string;
    children?: Array<{
        slug: string;
        name: string;
    }>;
};

export type FacetDefinition = {
    code: string;
    name: string;
};

export const CATALOG_COLLECTIONS: CollectionDefinition[] = [
    {
        slug: 'kukhni',
        name: 'Кухни',
        children: [
            { slug: 'kukhni_i_penaly', name: 'Кухни' },
            { slug: 'kukhonnye_nabory', name: 'Кухонные наборы' },
            { slug: 'kukhonnye_ostrova', name: 'Кухонные острова' },
            { slug: 'kukhonnye_penaly_i_antresoli', name: 'Кухонные пеналы и антресоли' },
        ],
    },
    {
        slug: 'mebel_dlya_gostinoy',
        name: 'Мебель для гостиной',
        children: [
            { slug: 'komody_s_zerkalami', name: 'Комоды с зеркалами' },
            { slug: 'komplekty_dlya_gostinoy', name: 'Комплекты для гостиной' },
            { slug: 'penaly', name: 'Пеналы' },
            { slug: 'tumby_pod_televizor', name: 'Тумбы под телевизор' },
            { slug: 'vitriny', name: 'Витрины' },
        ],
    },
    {
        slug: 'mebel_dlya_spalni',
        name: 'Мебель для спальни',
        children: [
            { slug: 'komody_1', name: 'Комоды' },
            { slug: 'komplekty_dlya_spalni', name: 'Комплекты мебели для спальни' },
            { slug: 'krovati', name: 'Кровати' },
            { slug: 'prikrovatnye_tumby', name: 'Прикроватные тумбы' },
            { slug: 'shkafy', name: 'Шкафы' },
            { slug: 'tualetnye_stoly', name: 'Туалетные столы' },
            { slug: 'zerkala_1', name: 'Зеркала' },
        ],
    },
    {
        slug: 'myagkaya_mebel',
        name: 'Мягкая мебель',
        children: [
            { slug: 'divany', name: 'Диваны' },
            { slug: 'komplekty_myagkoy_mebeli', name: 'Комплекты мягкой мебели' },
            { slug: 'kresla', name: 'Кресла' },
        ],
    },
    {
        slug: 'stoly_i_stulya',
        name: 'Столы и стулья',
        children: [
            { slug: 'komplekty_stolov_i_stulev', name: 'Комплекты столов и стульев' },
            { slug: 'stoly', name: 'Столы' },
            { slug: 'stulya', name: 'Стулья' },
            { slug: 'zhurnalnye_stoliki', name: 'Журнальные столики' },
        ],
    },
    {
        slug: 'shkafy_kupe',
        name: 'Шкафы-купе',
        children: [
            { slug: '2_stvorchatye', name: 'Шкафы-купе 2-створчатые' },
            { slug: '3_stvorchatye', name: 'Шкафы-купе 3-створчатые' },
        ],
    },
    {
        slug: 'dizaynerskie_resheniya',
        name: 'Дизайнерские решения',
        children: [{ slug: 'interernye_krovati_2', name: 'Интерьерные кровати' }],
    },
];

export const CATALOG_FACETS: FacetDefinition[] = [
    { code: 'brand', name: 'Бренд' },
    { code: 'style', name: 'Стиль' },
    { code: 'manufacturer-collection', name: 'Коллекция производителя' },
    { code: 'product-type', name: 'Тип товара' },
    { code: 'frame-material', name: 'Материал каркаса' },
    { code: 'facade-material', name: 'Материал фасада' },
    { code: 'edge-material', name: 'Материал кромки' },
    { code: 'shelf-material', name: 'Материал полок' },
    { code: 'countertop-material', name: 'Материал столешницы' },
    { code: 'upholstery-type', name: 'Тип обивки' },
    { code: 'hardware', name: 'Фурнитура' },
    { code: 'front-hardware', name: 'Лицевая фурнитура' },
    { code: 'sleeping-place', name: 'Спальное место' },
    { code: 'storage-box', name: 'Короб для хранения' },
    { code: 'transformation-mechanism', name: 'Механизм трансформации' },
    { code: 'foldable', name: 'Раскладной' },
    { code: 'mirror-on-facade', name: 'Зеркало на фасаде' },
    { code: 'glazing', name: 'Остекление' },
    { code: 'cornice-molding', name: 'Карниз / молдинг' },
    { code: 'bed-size', name: 'Размер кровати' },
    { code: 'sleeping-area-size', name: 'Размер спального места' },
    { code: 'seat-count', name: 'Количество мест' },
    { code: 'seating-capacity', name: 'Количество посадочных мест' },
    { code: 'door-count', name: 'Количество створок' },
    { code: 'shape', name: 'Форма' },
    { code: 'kitchen-product-type', name: 'Тип товара кухни' },
    { code: 'living-room-product-type', name: 'Тип товара гостиной' },
    { code: 'bedroom-product-type', name: 'Тип товара спальни' },
    { code: 'soft-furniture-type', name: 'Тип мягкой мебели' },
    { code: 'table-type', name: 'Тип столов' },
    { code: 'wardrobe-type', name: 'Тип шкафа' },
];

export const OPTION_GROUP_TEMPLATES = [
    { code: 'color-finish', name: 'Цвет / Отделка' },
    { code: 'color-upholstery', name: 'Цвет / Обивка' },
    { code: 'color-profile-finish', name: 'Цвет / Профиль / Отделка' },
] as const;

export function getCollectionTranslations(name: string, slug: string): CollectionTranslationDefinition[] {
    return [
        {
            languageCode: LanguageCode.en,
            name,
            slug,
            description: '',
        },
        {
            languageCode: LanguageCode.ru,
            name,
            slug,
            description: '',
        },
    ];
}

export function getFacetTranslations(name: string): FacetTranslationDefinition[] {
    return [
        {
            languageCode: LanguageCode.en,
            name,
        },
        {
            languageCode: LanguageCode.ru,
            name,
        },
    ];
}
