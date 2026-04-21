import { ChatContentBlock } from "./ChatContent";

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

export interface ChatSessionIdentityRecord {
  PK: string;
  SK: string;
  session_id: string;
  _createdAt_: string;
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
  // kickoff marker message commits successfully. Read by IdentityService to
  // expose kickoffCompletedAt on the wire so the frontend can decide whether
  // to dispatch the kickoff auto-greeting. Set via UpdateCommand with
  // if_not_exists so it is write-once — never clobbered.
  kickoff_completed_at?: string;
  budget_cents?: number;
  // Cart state — set by preview_cart on first call in the session, reused on
  // subsequent preview_cart calls (idempotent stable IDs via if_not_exists)
  // and read by generate_checkout_link to build the checkout URL.
  cart_id?: string; // bare cart ULID
  guest_id?: string; // bare guest ULID
  customer_id?: string; // bare customer ULID (no C# prefix)
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
