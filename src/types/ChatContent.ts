export interface ChatTextContentBlock {
  type: "text";
  text: string;
}

export interface ChatToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ChatToolResultContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ChatContentBlock = ChatTextContentBlock | ChatToolUseContentBlock | ChatToolResultContentBlock;
