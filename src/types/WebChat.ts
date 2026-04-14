export interface WebChatCreateSessionRequest {
  agentName: string;
  guestUlid: string;
}

export interface WebChatSendMessageRequest {
  sessionUlid: string;
  message: string;
}

export interface WebChatCreateSessionResponse {
  sessionUlid: string;
  displayName: string;
}

export interface WebChatSendMessageResponse {
  reply: string;
}

