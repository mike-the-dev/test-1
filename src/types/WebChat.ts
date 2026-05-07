import { SplashConfig } from "./SplashConfig";

export interface WebChatCreateSessionRequest {
  agentName: string;
  sessionId?: string;
  accountUlid: string;
}

export interface WebChatSendMessageRequest {
  sessionId: string;
  message: string;
}

export interface WebChatCreateSessionResponse {
  sessionId: string;
  displayName: string;
  onboardingCompletedAt: string | null;
  kickoffCompletedAt: string | null;
  splash: SplashConfig | null;
  onboardingData: Record<string, unknown> | null;
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
  onboardingData: Record<string, unknown>;
}

export interface WebChatOnboardingResponse {
  sessionId: string;
  onboardingCompletedAt: string;
  kickoffCompletedAt: string | null;
  onboardingData: Record<string, unknown>;
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
