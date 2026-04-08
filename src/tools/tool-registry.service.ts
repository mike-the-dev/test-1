import { Injectable, Inject, Logger } from "@nestjs/common";

import { ChatTool, ChatToolDefinition, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";

export const CHAT_TOOLS_TOKEN = "CHAT_TOOLS";

@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  constructor(@Inject(CHAT_TOOLS_TOKEN) private readonly tools: ChatTool[]) {}

  getAll(): ChatTool[] {
    return this.tools;
  }

  getDefinitions(): ChatToolDefinition[] {
    return this.tools.map((tool) => {
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      };
    });
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ChatToolExecutionContext,
  ): Promise<ChatToolExecutionResult> {
    const tool = this.tools.find((candidate) => candidate.name === toolName);

    if (!tool) {
      this.logger.warn(`Tool not found [name=${toolName}]`);

      return { result: `Tool not found: ${toolName}`, isError: true };
    }

    this.logger.debug(`Dispatching tool [name=${toolName} sessionUlid=${context.sessionUlid}]`);

    try {
      return await tool.execute(input, context);
    } catch (error) {
      this.logger.error(`Tool threw an error [name=${toolName}]`, error);

      return { result: "Tool execution failed unexpectedly.", isError: true };
    }
  }
}
