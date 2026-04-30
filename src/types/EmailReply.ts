export interface EmailReplySendGridInboundFormFields {
  to: string;
  from: string;
  text: string;
  subject?: string;
  html?: string;
  headers?: string;
  envelope?: string;
  dkim?: string;
  SPF?: string;
  sender_ip?: string;
  spam_score?: string;
  charsets?: string;
}

export interface EmailReplyParsedInboundReply {
  sessionUlid: string;
  senderEmail: string;
  subject: string;
  bodyText: string;
  inboundMessageId: string;
}

export enum EmailReplyLocalPartClassification {
  SESSION_ULID = "SESSION_ULID",
  ASSISTANT_ENTRY = "ASSISTANT_ENTRY",
  UNRECOGNIZED = "UNRECOGNIZED",
}

export type EmailReplyInboundProcessOutcome =
  | "processed"
  | "duplicate"
  | "rejected_unknown_session"
  | "rejected_sender_mismatch"
  | "rejected_malformed"
  | "rejected_unknown_account";

export interface EmailReplyRecord {
  PK: string;
  SK: string;
  processedAt: string;
  sessionUlid: string | null;
}
