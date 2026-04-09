import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { AnthropicService } from "./anthropic.service";
import { DatabaseConfigService } from "./database-config.service";
import { ToolRegistryService } from "../tools/tool-registry.service";
import { AgentRegistryService } from "../agents/agent-registry.service";
import { ChatSessionMessageRecord, ChatSessionNewMessage } from "../types/ChatSession";
import { ChatContentBlock, ChatToolResultContentBlock, ChatToolUseContentBlock } from "../types/ChatContent";

const MAX_TOOL_LOOP_ITERATIONS = 10;
const MAX_HISTORY_MESSAGES = 50;
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const MESSAGE_SK_PREFIX = "MESSAGE#";
const METADATA_SK = "METADATA";
const DEFAULT_AGENT_NAME = "lead_capture";

function buildUserTextMessage(text: string): ChatSessionNewMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function buildAssistantMessage(content: ChatContentBlock[]): ChatSessionNewMessage {
  return { role: "assistant", content };
}

function buildToolResultMessage(toolResultBlocks: ChatToolResultContentBlock[]): ChatSessionNewMessage {
  return { role: "user", content: toolResultBlocks };
}

function buildToolResultBlock(toolUseId: string, content: string, isError?: boolean): ChatToolResultContentBlock {
  if (isError) {
    return { type: "tool_result", tool_use_id: toolUseId, content, is_error: true };
  }

  return { type: "tool_result", tool_use_id: toolUseId, content };
}

@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly anthropicService: AnthropicService,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly agentRegistry: AgentRegistryService,
  ) {}

  async handleMessage(sessionUlid: string, userMessage: string): Promise<string> {
    try {
      const table = this.databaseConfig.conversationsTable;
      const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

      this.logger.debug(`Handling message [sessionUlid=${sessionUlid}]`);

      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: table,
          Key: { PK: sessionPk, SK: METADATA_SK },
        }),
      );

      const rawAgentName: string | undefined = metadataResult.Item?.agentName;
      const storedAgentName = rawAgentName || DEFAULT_AGENT_NAME;

      let resolvedAgent = this.agentRegistry.getByName(storedAgentName);

      if (resolvedAgent === null) {
        this.logger.warn(`Agent not found, falling back to default [sessionUlid=${sessionUlid} agentName=${storedAgentName}]`);

        resolvedAgent = this.agentRegistry.getByName(DEFAULT_AGENT_NAME);
      }

      if (resolvedAgent === null) {
        throw new Error("AgentRegistryService has no lead_capture agent registered. This is a misconfiguration.");
      }

      const agent = resolvedAgent;

      const allDefinitions = this.toolRegistry.getDefinitions();

      const filteredDefinitions = allDefinitions.filter((def) => {
        return agent.allowedToolNames.includes(def.name);
      });

      this.logger.log(`Agent resolved [sessionUlid=${sessionUlid} agentName=${agent.name} toolCount=${filteredDefinitions.length}]`);

      const historyResult = await this.dynamoDb.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": sessionPk,
            ":skPrefix": MESSAGE_SK_PREFIX,
          },
          ScanIndexForward: false,
          Limit: MAX_HISTORY_MESSAGES,
        }),
      );

      const items = historyResult.Items ?? [];

      this.logger.debug(`Loaded history [sessionUlid=${sessionUlid} count=${items.length}]`);

      const reversedItems = [...items].reverse();

      const history = reversedItems.map((item): ChatSessionNewMessage => {
        const rawContent = item.content;
        const role = item.role;

        try {
          const parsed: ChatContentBlock[] = JSON.parse(rawContent);
          return { role, content: parsed };
        } catch {
          this.logger.debug(`Legacy plain-string content detected [sessionUlid=${sessionUlid}]`);
          return { role, content: [{ type: "text", text: rawContent }] };
        }
      });

      const newUserMessage = buildUserTextMessage(userMessage);

      const messages = [...history, newUserMessage];

      const newMessages = [newUserMessage];

      let iteration = 0;

      while (iteration < MAX_TOOL_LOOP_ITERATIONS) {
        iteration++;

        this.logger.log(
          `Calling Anthropic [sessionUlid=${sessionUlid} iteration=${iteration} historySize=${messages.length}]`,
        );

        const response = await this.anthropicService.sendMessage([...messages], filteredDefinitions, agent.systemPrompt);

        const assistantMessage = buildAssistantMessage(response.content);

        messages.push(assistantMessage);
        newMessages.push(assistantMessage);

        if (response.stop_reason === "end_turn") {
          this.logger.log(`Tool loop complete [sessionUlid=${sessionUlid} iterations=${iteration}]`);
          break;
        }

        if (response.stop_reason !== "tool_use") {
          this.logger.warn(`Unexpected stop_reason [sessionUlid=${sessionUlid} stop_reason=${response.stop_reason}]`);
          break;
        }

        const toolUseBlocks: ChatToolUseContentBlock[] = [];

        for (const block of response.content) {
          if (block.type === "tool_use") {
            toolUseBlocks.push(block);
          }
        }

        this.logger.log(`Tool use detected [sessionUlid=${sessionUlid} count=${toolUseBlocks.length}]`);

        const toolResultBlocks = await Promise.all(
          toolUseBlocks.map(async (block) => {
            if (!agent.allowedToolNames.includes(block.name)) {
              this.logger.warn(`Tool not in agent allowlist [sessionUlid=${sessionUlid} agentName=${agent.name} toolName=${block.name}]`);

              return buildToolResultBlock(block.id, `Tool not available for this agent: ${block.name}`, true);
            }

            const executionResult = await this.toolRegistry.execute(block.name, block.input, { sessionUlid });

            return buildToolResultBlock(block.id, executionResult.result, executionResult.isError);
          }),
        );

        const toolResultMessage = buildToolResultMessage(toolResultBlocks);

        messages.push(toolResultMessage);
        newMessages.push(toolResultMessage);
      }

      if (iteration >= MAX_TOOL_LOOP_ITERATIONS) {
        this.logger.warn(`Tool loop max iterations reached [sessionUlid=${sessionUlid}]`);
      }

      const now = new Date().toISOString();

      for (const message of newMessages) {
        await this.dynamoDb.send(
          new PutCommand({
            TableName: table,
            Item: {
              PK: sessionPk,
              SK: `${MESSAGE_SK_PREFIX}${ulid()}`,
              role: message.role,
              content: JSON.stringify(message.content),
              createdAt: now,
            } satisfies ChatSessionMessageRecord,
          }),
        );
      }

      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: sessionPk, SK: METADATA_SK },
          UpdateExpression: "SET createdAt = if_not_exists(createdAt, :now), lastMessageAt = :now",
          ExpressionAttributeValues: { ":now": now },
        }),
      );

      this.logger.log(`Stored messages [sessionUlid=${sessionUlid} count=${newMessages.length}]`);

      const reversedMessages = [...messages].reverse();

      const lastAssistantMessage = reversedMessages.find((message) => message.role === "assistant");

      if (!lastAssistantMessage) {
        this.logger.warn(`No assistant message found in conversation [sessionUlid=${sessionUlid}]`);
        return "";
      }

      const assistantContent = lastAssistantMessage.content;

      const textBlocks = assistantContent.filter((block) => block.type === "text");

      const textParts = textBlocks.map((block) => {
        if (block.type === "text") {
          return block.text;
        }

        return "";
      });

      const finalText = textParts.join("");

      if (!finalText) {
        this.logger.warn(`No text blocks in final assistant message [sessionUlid=${sessionUlid}]`);
      }

      return finalText;
    } catch (error) {
      this.logger.error(`Failed to handle message [sessionUlid=${sessionUlid}]`, error);
      throw error;
    }
  }
}
