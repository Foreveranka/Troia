// The STORE catalogue. A demo streetwear line — no real inventory. Prices are in USD; the checkout later
// converts to a single lira total via the Troia backend. Product tiles are generated from `hue` (no photos),
// which keeps the store self-contained and on-brand (a washed / glitched aesthetic).

export type ProductCategory = 'Tops' | 'Outerwear' | 'Bottoms' | 'Accessories';
export type ProductTag = 'new' | 'limited' | 'sold out';

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly colorway: string;
  readonly price: number; // USD (original)
  readonly category: ProductCategory;
  readonly hue: number; // 0-360, drives the stylized tile gradient
  readonly tag?: ProductTag;
  readonly sale?: number; // percent off, if on sale
}

export const PRODUCTS: readonly Product[] = [
  {
    id: 'static-tee',
    name: 'STATIC TEE',
    colorway: 'Washed Black',
    price: 62,
    category: 'Tops',
    hue: 210,
    tag: 'new',
  },
  {
    id: 'ghost-hoodie',
    name: 'GHOST HOODIE',
    colorway: 'Fog Grey',
    price: 138,
    category: 'Outerwear',
    hue: 250,
    sale: 20,
  },
  {
    id: 'decay-cargo',
    name: 'DECAY CARGO',
    colorway: 'Oil Slick',
    price: 116,
    category: 'Bottoms',
    hue: 160,
  },
  {
    id: 'null-longsleeve',
    name: 'NULL LONGSLEEVE',
    colorway: 'Bone',
    price: 78,
    category: 'Tops',
    hue: 40,
  },
  {
    id: 'signal-shorts',
    name: 'SIGNAL SHORTS',
    colorway: 'Ash',
    price: 70,
    category: 'Bottoms',
    hue: 300,
    tag: 'new',
  },
  {
    id: 'glitch-tee',
    name: 'GLITCH TEE',
    colorway: 'Acid',
    price: 68,
    category: 'Tops',
    hue: 90,
    tag: 'limited',
  },
  {
    id: 'ruin-jacket',
    name: 'RUIN JACKET',
    colorway: 'Charred',
    price: 214,
    category: 'Outerwear',
    hue: 12,
    tag: 'limited',
  },
  {
    id: 'terminal-crew',
    name: 'TERMINAL CREWNECK',
    colorway: 'Slate',
    price: 124,
    category: 'Tops',
    hue: 200,
    sale: 25,
  },
  {
    id: 'offgrid-cap',
    name: 'OFFGRID CAP',
    colorway: 'Washed Pink',
    price: 46,
    category: 'Accessories',
    hue: 340,
  },
  {
    id: 'void-beanie',
    name: 'VOID BEANIE',
    colorway: 'Black',
    price: 38,
    category: 'Accessories',
    hue: 270,
    sale: 15,
  },
  {
    id: 'fracture-vest',
    name: 'FRACTURE VEST',
    colorway: 'Storm',
    price: 98,
    category: 'Outerwear',
    hue: 190,
    tag: 'sold out',
  },
  {
    id: 'noise-sweatpant',
    name: 'NOISE SWEATPANT',
    colorway: 'Static Grey',
    price: 104,
    category: 'Bottoms',
    hue: 320,
    sale: 30,
  },
  // newer drop — spread across every category so the New filter never comes up empty
  {
    id: 'drift-tee',
    name: 'DRIFT TEE',
    colorway: 'Faded Ink',
    price: 64,
    category: 'Tops',
    hue: 230,
    tag: 'new',
  },
  {
    id: 'echo-crew',
    name: 'ECHO CREWNECK',
    colorway: 'Forest Green',
    price: 118,
    category: 'Tops',
    hue: 140,
    tag: 'new',
  },
  {
    id: 'pulse-anorak',
    name: 'PULSE ANORAK',
    colorway: 'Golden Yellow',
    price: 168,
    category: 'Outerwear',
    hue: 45,
    tag: 'new',
  },
  {
    id: 'relay-cargo',
    name: 'RELAY CARGO',
    colorway: 'Washed Navy',
    price: 122,
    category: 'Bottoms',
    hue: 220,
    tag: 'new',
  },
  {
    id: 'signal-cap',
    name: 'SIGNAL CAP',
    colorway: 'Burgundy',
    price: 44,
    category: 'Accessories',
    hue: 350,
    tag: 'new',
  },
];

export const CATEGORIES: readonly (ProductCategory | 'All')[] = [
  'All',
  'Tops',
  'Outerwear',
  'Bottoms',
  'Accessories',
];

export const SIZES = ['S', 'M', 'L', 'XL'] as const;
export type Size = (typeof SIZES)[number];

/** The effective price (applies a sale if present) plus the crossed-out original when discounted. */
export function priceOf(p: Product): { now: number; was: number | null } {
  if (p.sale) return { now: Math.round(p.price * (1 - p.sale / 100)), was: p.price };
  return { now: p.price, was: null };
}

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

// ---- product imagery ----
// One bundled photo per product, served from public/products (source file extensions differ, so map explicitly).
const PHOTOS: Record<string, string> = {
  'static-tee': 'static-tee-1.png',
  'ghost-hoodie': 'ghost-hoodie-1.webp',
  'decay-cargo': 'decay-cargo-1.png',
  'null-longsleeve': 'null-longsleeve-1.png',
  'signal-shorts': 'signal-shorts-1.png',
  'glitch-tee': 'glitch-tee-1.jpg',
  'ruin-jacket': 'ruin-jacket-1.png',
  'terminal-crew': 'terminal-crew-1.jpeg',
  'offgrid-cap': 'offgrid-cap-1.png',
  'void-beanie': 'void-beanie-1.png',
  'fracture-vest': 'fracture-vest-1.png',
  'noise-sweatpant': 'noise-sweatpant-1.png',
  'drift-tee': 'drift-tee-1.jpg',
  'echo-crew': 'echo-crew-1.png',
  'pulse-anorak': 'pulse-anorak-1.jpg',
  'relay-cargo': 'relay-cargo-1.png',
  'signal-cap': 'signal-cap-1.png',
};

/** The product's photo URL (served from /public), or null if none is bundled. */
export function imageOf(p: Product): string | null {
  const file = PHOTOS[p.id];
  return file ? `/products/${file}` : null;
}

// A distinct, garment-specific description per product — each one calls out the piece's colour, defining
// detail, fabric and fit so it reads like a real product page (and no two are alike).
const DESCRIPTIONS: Record<string, string> = {
  'static-tee':
    'A heavyweight washed-black tee with a boxy, oversized cut and dropped shoulders. Mineral-washed to a dusty, faded finish with light natural distressing scattered across the body.',
  'ghost-hoodie':
    'A brushed mohair-blend hoodie in fog grey with a soft, hazy halo texture. A faded flag graphic sits across the chest, worn in like it has been through a hundred washes.',
  'decay-cargo':
    'Wide-leg cargo pants in an oil-slick coated wash that shifts between grey, brown and iridescent blue. Oversized bellowed side pockets, pleated knees and drawcord hems.',
  'null-longsleeve':
    'A bone garment-dyed long sleeve with an oversized, boxy body and ribbed cuffs. Scattered thrashing and pinholes give it a salvaged, decades-old feel.',
  'signal-shorts':
    'Pigment-washed sweat shorts in ash grey with an elastic drawcord waist. A mid-length, relaxed cut with faint distressing and a soft, broken-in hand-feel.',
  'glitch-tee':
    'An acid-wash tee in corroded green carrying a glitched, torn-apart print that looks like a signal breaking up. High-contrast, boxy and cut for an oversized drape.',
  'ruin-jacket':
    'A charred acid-wash zip jacket with a stand collar and a panelled, workwear front. Cracked, uneven dye and ripped detailing make each piece read one of one.',
  'terminal-crew':
    'A slate heavyweight crewneck with a clean, boxy silhouette and ribbed trims. Brushed-back loopwheel fleece in a flat, tonal slate grey.',
  'offgrid-cap':
    'A washed-pink six-panel dad cap in a soft, sun-faded mauve. Unstructured with a low crown, a curved brim and clean stitching, understated and free of branding.',
  'void-beanie':
    'A ribbed cuffed beanie in deep black, knitted from a soft wool-mohair blend. Minimal and snug, built to sit just above the eyes.',
  'fracture-vest':
    'A storm-grey utility vest with a full zip and boxy, padded panels. A matte technical shell with taped seams and a distressed, fractured surface texture.',
  'noise-sweatpant':
    'Heavyweight sweatpants in static grey with a relaxed, tapered leg and an elastic drawcord waist. Garment-washed with faint abrasion for a lived-in, staticky grey.',
  'drift-tee':
    'An oversized tee with a smoky gradient wash that drifts from inky blue-grey at the shoulders down to bone white at the hem. Soft, thin cotton with faint speckled distressing and a boxy, dropped-shoulder cut.',
  'echo-crew':
    'A forest-green crewneck knit with a soft, brushed mohair-like halo. Boxy and slightly cropped, with a ribbed crew collar, cuffs and hem.',
  'pulse-anorak':
    'A golden-yellow technical anorak with a half-zip placket, a drawcord hood and a matte weatherproof shell. A single kangaroo pocket and fully blacked-out hardware throughout.',
  'relay-cargo':
    'Washed-navy ripstop cargo pants in a wide, relaxed cut with bellowed thigh pockets and drawcord toggle hems. Finished with tonal field stencils and an RLY-08 star emblem, military-inspired throughout.',
  'signal-cap':
    'A washed-burgundy six-panel cap with a soft, low crown and a curved brim. A small tonal emblem is embroidered on the front panel, quiet and self-coloured.',
};

/** The garment-specific description for a product (falls back to a minimal line if none is defined). */
export function descriptionOf(p: Product): string {
  return DESCRIPTIONS[p.id] ?? `${p.name} in ${p.colorway}.`;
}
