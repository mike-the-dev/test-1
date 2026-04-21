export interface WebChatCreateSessionRequest {
  agentName: string;
  guestUlid: string;
  accountUlid: string;
}

export interface WebChatSendMessageRequest {
  sessionUlid: string;
  message: string;
}

export interface WebChatCreateSessionResponse {
  sessionUlid: string;
  displayName: string;
  onboardingCompletedAt: string | null;
  kickoffCompletedAt: string | null;
  budgetCents: number | null;
}

export interface WebChatToolOutput {
  /** Stable per-call identifier (Anthropic tool_use_id). Safe to use as a React key. */
  call_id: string;
  tool_name: string;
  content: string;
  is_error?: boolean;
}

export interface WebChatSendMessageResponse {
  reply: string;
  tool_outputs?: WebChatToolOutput[];
}

export interface WebChatOnboardingRequest {
  budgetCents: number;
}

export interface WebChatOnboardingResponse {
  sessionUlid: string;
  onboardingCompletedAt: string;
  kickoffCompletedAt: string | null;
  budgetCents: number;
}

export interface WebChatHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface WebChatMessagesResponse {
  messages: WebChatHistoryMessage[];
}

export interface WebChatEmbedAuthorizeResponse {
  authorized: boolean;
}
