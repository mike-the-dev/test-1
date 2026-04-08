import { SetMetadata } from "@nestjs/common";

export const CHAT_TOOL_METADATA = "chat_tool";

/**
 * Marks a class as a chat tool that will be auto-discovered by ToolRegistryService
 * during onModuleInit. Any class decorated with @ChatToolProvider() and added to
 * AppModule providers will be collected and made available through the tool registry.
 */
export const ChatToolProvider = () => SetMetadata(CHAT_TOOL_METADATA, true);
