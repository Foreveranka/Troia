// Domain request shapes. These model the iyzico fields Troia sends; the builders assemble them in a fixed
// key order and apply formatPrice. No SDK types (the @types/iyzipay package is incomplete — it omits
// errorCode/errorMessage/errorGroup — so we own our types). No secrets, no raw-card persistence.

export type Locale = 'tr' | 'en';

export interface Buyer {
  readonly id: string;
  readonly name: string;
  readonly surname: string;
  readonly identityNumber: string;
  readonly email: string;
  readonly registrationAddress: string;
  readonly city: string;
  readonly country: string;
  readonly ip: string;
  readonly gsmNumber?: string;
  readonly zipCode?: string;
}

export interface Address {
  readonly contactName: string;
  readonly city: string;
  readonly country: string;
  readonly address: string;
  readonly zipCode?: string;
}

export interface BasketItem {
  readonly id: string;
  readonly name: string;
  readonly category1: string;
  readonly itemType: 'PHYSICAL' | 'VIRTUAL';
  readonly price: string | number; // formatPrice-normalized by the builder
}

export interface PaymentCard {
  readonly cardHolderName: string;
  readonly cardNumber: string;
  readonly expireMonth: string;
  readonly expireYear: string;
  readonly cvc: string;
  readonly registerCard?: number;
}
