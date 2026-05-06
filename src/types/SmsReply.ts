export interface SmsReplyTwilioInboundFormFields {
  MessageSid: string;
  AccountSid: string;
  From: string; // E.164 sender, e.g., "+15551234567"
  To: string; // E.164 deployment number, e.g., "+15558675309"
  Body: string; // raw message body
  NumMedia?: string; // count of attachments (digits as string); 0 expected for v1
  FromCity?: string;
  FromState?: string;
  FromCountry?: string;
}

export type SmsReplyInboundProcessOutcome =
  | "processed"
  | "duplicate"
  | "rejected_unknown_account"
  | "rejected_signature_invalid"
  | "rejected_malformed";

export interface SmsReplyRecord {
  PK: string; // "SMS_INBOUND#<MessageSid>"
  SK: string; // "METADATA"
  processedAt: string; // ISO 8601
  sessionId: string | null; // "CHAT_SESSION#<sessionUlid>" or null
}
