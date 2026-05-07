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
  DOMAIN_ROUTED = "DOMAIN_ROUTED",
}

export type EmailReplyInboundProcessOutcome =
  | "processed"
  | "duplicate"
  | "rejected_unknown_session"
  | "rejected_sender_mismatch"
  | "rejected_malformed"
  | "rejected_unknown_account"
  | "rejected_unknown_local_part";

export interface EmailReplyRecord {
  PK: string;
  SK: string;
  processedAt: string; // ISO 8601 — when the inbound was first received and dedupe-locked
  sessionId: string | null; // "CHAT_SESSION#<sessionUlid>" or null
  _createdAt_: string;
  _lastUpdated_: string;
}
