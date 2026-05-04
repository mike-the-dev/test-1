import { ChatContentBlock } from "./ChatContent";

/** Return type for SessionService.updateOnboarding(). */
export interface ChatSessionUpdateOnboardingResult {
  sessionUlid: string;
  onboardingCompletedAt: string;
  kickoffCompletedAt: string | null;
  budgetCents: number;
}

/** Return type for SessionService.lookupOrCreateSession(). */
export interface ChatSessionLookupOrCreateResult {
  sessionUlid: string;
  onboardingCompletedAt: string | null;
  kickoffCompletedAt: string | null;
  budgetCents: number | null;
  wasCreated: boolean;
}

export type ChatSessionRole = "user" | "assistant";

/**
 * In-memory representation of a chat message.
 * Content is a plain string for legacy/simple messages or a parsed block array
 * for messages involving tool use.
 */
export interface ChatSessionMessage {
  role: ChatSessionRole;
  content: string | ChatContentBlock[];
}

/** Parsed content block array — the structured form of stored message content. */
export type ChatSessionMessageContent = ChatContentBlock[];

/** A message whose content is always a structured block array. Used for new messages in the persistence loop. */
export interface ChatSessionNewMessage {
  role: ChatSessionRole;
  content: ChatContentBlock[];
}

/** Slim response shape returned from AnthropicService to ChatSessionService. */
export interface ChatAnthropicResponse {
  content: ChatContentBlock[];
  stop_reason: string;
}

export interface ChatSessionMessageRecord {
  PK: string;
  SK: string;
  role: ChatSessionRole;
  content: string;
  _createdAt_: string;
}

export interface ChatSessionMetadataRecord {
  PK: string;
  SK: string;
  _createdAt_: string;
  _lastUpdated_: string;
  source: string;
  agent_name?: string;
  account_id?: string;
  onboarding_completed_at?: string;
  // Stamped by ChatSessionService.handleMessage the first time the session's
  // kickoff marker message commits successfully. Read by the web-chat controller
  // and SessionService.updateOnboarding to expose kickoffCompletedAt on the wire
  // so the frontend can decide whether to dispatch the kickoff auto-greeting.
  // Set via UpdateCommand with if_not_exists so it is write-once — never clobbered.
  kickoff_completed_at?: string;
  budget_cents?: number;
  // Cart state — set by preview_cart on first call in the session, reused on
  // subsequent preview_cart calls (idempotent stable IDs via if_not_exists)
  // and read by generate_checkout_link to build the checkout URL.
  cart_id?: string; // bare cart ULID
  guest_id?: string; // bare guest ULID
  customer_id?: string | null; // "C#<customerUlid>" on verification success; absent on creation — set by collect_contact_info or verify_code
  // Stamped by verify_code on success. Stores the bare session ULID that was in
  // customer.latest_session_id at the moment of verification — i.e., the visitor's
  // most-recent prior session, before this one. Absent if verify_code was never called,
  // if verification failed, or if the customer had no prior session (first return).
  continuation_from_session_id?: string | null;
  // Stamped by the prior-history loader on its first fire in a session (ISO 8601).
  // Non-null value is the gate that prevents the loader from firing a second time.
  // Absent on creation — set by the continuation loader on first fire.
  continuation_loaded_at?: string | null;
  customer_email?: string;
}

/**
 * Account-scoped pointer record that lets us Query all chat sessions under an
 * account (PK = "A#<accountUlid>", SK = "CHAT_SESSION#<sessionUlid>") without
 * scanning or crossing to a GSI. Full session state (messages, contact info,
 * user facts) continues to live under PK = "CHAT_SESSION#<sessionUlid>" —
 * this record is a lightweight index, not the source of truth.
 */
export interface ChatSessionPointerRecord {
  PK: string;
  SK: string;
  entity: "CHAT_SESSION";
  session_id: string;
  agent_name: string;
  source: string;
  _createdAt_: string;
  _lastUpdated_: string;
}

/** Result returned by collect_contact_info. isReturningVisitor is only present (and always true) when the contact trio completed and matched an existing customer record. */
export type CollectContactInfoSavedResult = { saved: true; isReturningVisitor?: true };

/** Visitor profile fields used by the prior-history loader's continuation context block. */
export interface ChatSessionContinuationProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
}
