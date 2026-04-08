import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DiscoveryService, Reflector } from "@nestjs/core";

import { ChatTool, ChatToolDefinition, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { CHAT_TOOL_METADATA } from "./chat-tool.decorator";

@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistryService.name);

  private tools: ChatTool[] = [];

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const wrappers = this.discoveryService.getProviders();

    const toolWrappers = wrappers.filter((wrapper) => {
      const metatype = wrapper.metatype;

      if (metatype === null || metatype === undefined) {
        return false;
      }

      return this.reflector.get(CHAT_TOOL_METADATA, metatype) === true;
    });

    const discovered = toolWrappers.map((wrapper) => {
      return wrapper.instance;
    });

    const validInstances = discovered.filter((instance) => {
      return instance !== null && instance !== undefined;
    });

    this.tools = validInstances;

    const count = this.tools.length;
    const toolNames = this.tools.map((tool) => {
      return tool.name;
    });
    const names = toolNames.join(", ");

    this.logger.log(`Discovered chat tools [count=${count} names=${names}]`);

    if (count === 0) {
      this.logger.warn(
        "No chat tools discovered. Verify that tool classes are decorated with @ChatToolProvider() and registered in AppModule providers.",
      );
    }
  }

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
