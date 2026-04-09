import { SetMetadata } from "@nestjs/common";

export const CHAT_AGENT_METADATA = "chat_agent";

/**
 * Marks a class as a chat agent that will be auto-discovered by AgentRegistryService during
 * onModuleInit. Any class decorated with @ChatAgentProvider() and added to AppModule providers
 * will be collected and made available through the agent registry.
 */
export const ChatAgentProvider = () => SetMetadata(CHAT_AGENT_METADATA, true);
