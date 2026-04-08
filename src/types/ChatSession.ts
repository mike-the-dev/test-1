export type ChatSessionRole = "user" | "assistant";

export interface ChatSessionMessage {
  role: ChatSessionRole;
  content: string;
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
}
