export interface SlackAlertBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackAlertPayload {
  text: string;
  blocks: SlackAlertBlock[];
}

export interface CartItemAlertEntry {
  name: string;
  quantity: number;
  subtotalCents: number;
}

export interface SlackAlertConversationStartedInput {
  accountId: string;
  sessionUlid: string;
}

export interface SlackAlertCartCreatedInput {
  accountId: string;
  sessionUlid: string;
  guestCartId: string;
  cartTotalCents: number;
  itemCount: number;
  items: readonly CartItemAlertEntry[];
}

export interface SlackAlertCheckoutLinkGeneratedInput {
  accountId: string;
  sessionUlid: string;
  guestCartId: string;
  cartTotalCents: number;
  items: readonly CartItemAlertEntry[];
  checkoutUrl: string;
}
