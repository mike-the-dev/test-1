export interface SlackAlertBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackAlertPayload {
  text: string;
  blocks: SlackAlertBlock[];
}

export interface SlackAlertConversationStartedInput {
  accountId: string;
  sessionUlid: string;
}

export interface SlackAlertCartCreatedInput {
  accountId: string;
  sessionUlid: string;
  cartTotalCents: number;
  itemCount: number;
}

export interface SlackAlertCheckoutLinkGeneratedInput {
  accountId: string;
  sessionUlid: string;
  checkoutUrl: string;
}
