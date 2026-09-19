// NOVAKEYS catalogue. Fictional titles, no real inventory. Prices are USD; the checkout converts to a single
// lira total through the Troia backend. Cover art is generated from `hue` so the store stays self-contained.

export type Genre = 'Action' | 'Strategy' | 'Racing' | 'Horror' | 'Indie';
export type Tag = 'new' | 'preorder' | 'bestseller';

export interface Game {
  readonly id: string;
  readonly name: string;
  readonly studio: string;
  readonly price: number;
  readonly genre: Genre;
  readonly hue: number;
  readonly platform: string;
  readonly tag?: Tag;
  readonly sale?: number; // percent off
}

export const GAMES: readonly Game[] = [
  {
    id: 'echo-protocol',
    name: 'ECHO PROTOCOL',
    studio: 'Halfline Studio',
    price: 0.50,
    genre: 'Action',
    hue: 268,
    platform: 'PC · Steam key',
    tag: 'bestseller',
  },
  {
    id: 'neon-drift-2',
    name: 'NEON DRIFT II',
    studio: 'Vantage Works',
    price: 0.50,
    genre: 'Racing',
    hue: 190,
    platform: 'PC · Steam key',
    sale: 25,
  },
  {
    id: 'hollow-signal',
    name: 'HOLLOW SIGNAL',
    studio: 'Grey Room',
    price: 0.50,
    genre: 'Horror',
    hue: 12,
    platform: 'PC · Steam key',
    tag: 'new',
  },
  {
    id: 'orbital-decay',
    name: 'ORBITAL DECAY',
    studio: 'Northpoint',
    price: 0.50,
    genre: 'Strategy',
    hue: 220,
    platform: 'PC · Deluxe edition',
    tag: 'preorder',
  },
  {
    id: 'static-runner',
    name: 'STATIC RUNNER',
    studio: 'Two Owls',
    price: 0.50,
    genre: 'Indie',
    hue: 92,
    platform: 'PC · Steam key',
  },
  {
    id: 'void-atlas',
    name: 'VOID ATLAS',
    studio: 'Meridian Games',
    price: 0.50,
    genre: 'Strategy',
    hue: 314,
    platform: 'PC · Steam key',
    sale: 40,
  },
  {
    id: 'ashfall',
    name: 'ASHFALL',
    studio: 'Coldwater',
    price: 0.50,
    genre: 'Action',
    hue: 32,
    platform: 'PC · Steam key',
  },
  {
    id: 'paper-city',
    name: 'PAPER CITY',
    studio: 'Two Owls',
    price: 0.50,
    genre: 'Indie',
    hue: 158,
    platform: 'PC · Steam key',
    tag: 'new',
  },
];

export function priceOf(g: Game): { now: number; was: number | null } {
  if (g.sale === undefined) return { now: g.price, was: null };
  const now = Math.round(g.price * (1 - g.sale / 100) * 100) / 100;
  return { now, was: g.price };
}

export const usd = (n: number): string =>
  '$' + n.toFixed(2).replace(/\.00$/, '');
