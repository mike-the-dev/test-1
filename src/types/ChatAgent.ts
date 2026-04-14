/**
 * Each registered agent is a contract: the registry trusts that any provider
 * marked with @ChatAgentProvider() implements this interface correctly.
 */
export interface ChatAgent {
  readonly name: string;
  readonly displayName?: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly allowedToolNames: readonly string[];
}
