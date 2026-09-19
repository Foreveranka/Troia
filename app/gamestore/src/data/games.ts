// Demonstration catalogue. No physical goods are shipped. Prices are test USDC.
export type Genre = 'Tops' | 'Outerwear' | 'Bottoms' | 'Accessories';
export interface Game {
  readonly id: string; readonly name: string; readonly studio: string;
  readonly price: number; readonly genre: Genre; readonly image: string;
  readonly platform: string; readonly tag?: string; readonly sale?: number;
}
export const GAMES: readonly Game[] = [
  {id:'static-tee',name:'Static Tee',studio:'Washed black',price:0.50,genre:'Tops',image:'/products/static-tee-1.png',platform:'Relaxed fit',tag:'The essentials'},
  {id:'ghost-hoodie',name:'Ghost Hoodie',studio:'Fog grey',price:0.50,genre:'Outerwear',image:'/products/ghost-hoodie-1.webp',platform:'Heavyweight fleece'},
  {id:'decay-cargo',name:'Decay Cargo',studio:'Oil slick',price:0.50,genre:'Bottoms',image:'/products/decay-cargo-1.png',platform:'Utility fit'},
  {id:'null-longsleeve',name:'Null Longsleeve',studio:'Bone',price:0.50,genre:'Tops',image:'/products/null-longsleeve-1.png',platform:'Everyday layer'},
  {id:'signal-cap',name:'Signal Cap',studio:'Muted earth',price:0.50,genre:'Accessories',image:'/products/signal-cap-1.png',platform:'Adjustable fit'},
  {id:'void-beanie',name:'Void Beanie',studio:'Charcoal',price:0.50,genre:'Accessories',image:'/products/void-beanie-1.png',platform:'Ribbed knit'},
];
export function priceOf(g: Game): {now:number;was:number|null} { return {now:g.price,was:null}; }
export const usd = (n:number):string => n.toFixed(2)+' USDC';
