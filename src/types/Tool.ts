/** JSON schema object passed to Anthropic as the input_schema for a tool. */
export interface ChatToolInputSchema {
  type: "object";
  properties?: unknown | null;
  required?: string[] | null;
  [key: string]: unknown;
}

/** The shape sent to Anthropic in the tools array of a messages.create() call. */
export interface ChatToolDefinition {
  name: string;
  description: string;
  input_schema: ChatToolInputSchema;
}

/** Context passed into a tool's execute method. */
export interface ChatToolExecutionContext {
  sessionUlid: string;
  accountUlid?: string;
}

/** The result returned by a tool's execute method. */
export interface ChatToolExecutionResult {
  result: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/** Interface that every concrete tool must implement. */
export interface ChatTool {
  name: string;
  description: string;
  inputSchema: ChatToolInputSchema;
  /**
   * When true, only the most recent tool_output for this tool name survives
   * a multi-call turn. Use for tools whose result describes mutable state that
   * the latest call overwrites (e.g., cart preview, checkout link generation).
   * Leave unset for tools that emit independent events (e.g., save_user_fact).
   */
  emitLatestOnly?: boolean;
  execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult>;
}
