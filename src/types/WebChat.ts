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
  budgetCents: number | null;
}

export interface WebChatSendMessageResponse {
  reply: string;
}

export interface WebChatOnboardingRequest {
  budgetCents: number;
}

export interface WebChatOnboardingResponse {
  sessionUlid: string;
  onboardingCompletedAt: string;
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
