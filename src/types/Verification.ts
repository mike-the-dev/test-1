export interface VerificationCodeRecord {
  PK: string;
  SK: "VERIFICATION_CODE";
  entity: "VERIFICATION_CODE";
  code_hash: string;
  email: string;
  expires_at: string;
  attempts: number;
  request_count_in_window: number;
  request_window_start_at: string;
  ttl: number;
  _createdAt_: string;
  _lastUpdated_: string;
}

export type VerificationRequestCodeResult =
  | { sent: true }
  | { sent: false; reason: "no_email_in_session" }
  | { sent: false; reason: "rate_limited" }
  | { sent: false; reason: "send_failed" };

export type VerificationVerifyCodeResult =
  | { verified: true; customerId: string }
  | { verified: false; reason: "no_pending_code" }
  | { verified: false; reason: "expired" }
  | { verified: false; reason: "max_attempts" }
  | { verified: false; reason: "wrong_code" };
