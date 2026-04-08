export interface EmailSendParams {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSendResult {
  messageId: string;
}
