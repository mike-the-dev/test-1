export interface EmailSendParams {
  to: string;
  subject: string;
  body: string;
  sessionUlid: string;
  replyDomain?: string; // optional — reply-service-originated sends pass this
  fromName?: string; // optional — reply-service-originated sends pass this
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

/** Shape of extra properties the SendGrid SDK appends to Error instances. */
export type EmailSendGridSdkError = Error & {
  code?: number | string;
  response?: { body?: unknown };
};
