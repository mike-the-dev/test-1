export interface SmsSendParams {
  to: string; // E.164 recipient phone number
  body: string; // message text
  sessionUlid?: string; // used for log tracing only
}

export interface SmsSendResult {
  messageSid: string;
}

/** Shape of extra properties the Twilio SDK appends to Error instances. */
export type SmsTwilioSdkError = Error & {
  code?: number | string;
  moreInfo?: string;
};

/** Normalised fields extracted from a SmsTwilioSdkError for structured logging. */
export interface SmsSdkErrorFields {
  code: string;
  moreInfo: string;
}
