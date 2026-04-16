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
  sessionUlid: string;
  createdAt: string;
}

export interface ChatSessionMessageRecord {
  PK: string;
  SK: string;
  role: ChatSessionRole;
  content: string;
  createdAt: string;
}

export interface ChatSessionMetadataRecord {
  PK: string;
  SK: string;
  createdAt: string;
  lastMessageAt: string;
  source: string;
  agentName?: string;
  accountUlid?: string;
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
  sessionUlid: string;
  agentName: string;
  source: string;
  createdAt: string;
  lastMessageAt: string;
}
