export interface EmailSendParams {
  to: string;
  subject: string;
  body: string;
  sessionUlid: string;
  inReplyToMessageId?: string;
  referencesMessageId?: string;
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailOutboundMessage {
  from: { email: string; name: string };
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}
