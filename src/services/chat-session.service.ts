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
import { WebChatHistoryMessage, WebChatToolOutput } from "../types/WebChat";

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

  async handleMessage(
    sessionUlid: string,
    userMessage: string,
  ): Promise<{ reply: string; toolOutputs: WebChatToolOutput[] }> {
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

      const rawAgentName: string | undefined = metadataResult.Item?.agent_name;
      const storedAgentName = rawAgentName || DEFAULT_AGENT_NAME;
      const accountUlid = metadataResult.Item?.account_id;
      const budgetCents: number | undefined = metadataResult.Item?.budget_cents;

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

        const dynamicSystemContext =
          budgetCents !== undefined && budgetCents !== null
            ? `User context: shopping budget is approximately $${Math.floor(budgetCents / 100)}.`
            : undefined;

        const response = await this.anthropicService.sendMessage(
          [...messages],
          filteredDefinitions,
          agent.systemPrompt,
          dynamicSystemContext,
        );

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

            const executionResult = await this.toolRegistry.execute(block.name, block.input, { sessionUlid, accountUlid });

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
              _createdAt_: now,
            } satisfies ChatSessionMessageRecord,
          }),
        );
      }

      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: sessionPk, SK: METADATA_SK },
          UpdateExpression: "SET #createdAt = if_not_exists(#createdAt, :now), #lastUpdated = :now",
          ExpressionAttributeNames: { "#createdAt": "_createdAt_", "#lastUpdated": "_lastUpdated_" },
          ExpressionAttributeValues: { ":now": now },
        }),
      );

      // Also update _lastUpdated_ on the account-scoped session pointer so
      // per-account "sessions sorted by recency" queries stay accurate. The
      // condition guards against creating a partial pointer for legacy
      // sessions that never got one; if the pointer does not exist, this
      // quietly no-ops. Best-effort: pointer-sync failures do not break
      // message handling.
      if (accountUlid) {
        try {
          await this.dynamoDb.send(
            new UpdateCommand({
              TableName: table,
              Key: { PK: `A#${accountUlid}`, SK: sessionPk },
              UpdateExpression: "SET #lastUpdated = :now",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
              ExpressionAttributeValues: { ":now": now },
            }),
          );
        } catch (pointerError) {
          const errorName = pointerError instanceof Error ? pointerError.name : "UnknownError";

          if (errorName !== "ConditionalCheckFailedException") {
            this.logger.warn(
              `Session pointer lastMessageAt update failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
            );
          }
        }
      }

      this.logger.log(`Stored messages [sessionUlid=${sessionUlid} count=${newMessages.length}]`);

      // Concatenate text from every assistant message emitted during this turn.
      // Handles the case where Claude speaks text alongside an inline tool_use in an
      // earlier iteration and then returns an empty end_turn message after the tool
      // result — the text belongs to the user-facing reply even though it is not in
      // the final assistant message.
      const assistantMessagesThisTurn = newMessages.filter((message) => message.role === "assistant");

      const textParts: string[] = [];

      for (const assistantMessage of assistantMessagesThisTurn) {
        for (const block of assistantMessage.content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          }
        }
      }

      const finalText = textParts.join("\n\n").trim();

      if (!finalText) {
        this.logger.warn(`No text blocks across any assistant messages this turn [sessionUlid=${sessionUlid}]`);
      }

      // Collect structured tool outputs from this turn so the frontend can
      // render typed components (cart card, etc.) keyed by tool name. Agent-
      // agnostic: every tool result flows through; renderers live frontend-side
      // and ignore tools they don't know.
      const toolUseNamesById = new Map<string, string>();

      for (const assistantMessage of assistantMessagesThisTurn) {
        for (const block of assistantMessage.content) {
          if (block.type === "tool_use") {
            toolUseNamesById.set(block.id, block.name);
          }
        }
      }

      const collected: WebChatToolOutput[] = [];

      for (const message of newMessages) {
        if (message.role !== "user") {
          continue;
        }

        for (const block of message.content) {
          if (block.type !== "tool_result") {
            continue;
          }

          const toolName = toolUseNamesById.get(block.tool_use_id);

          if (!toolName) {
            continue;
          }

          if (typeof block.content !== "string") {
            continue;
          }

          collected.push({
            call_id: block.tool_use_id,
            tool_name: toolName,
            content: block.content,
            ...(block.is_error === true ? { is_error: true } : {}),
          });
        }
      }

      // Dedupe "latest-only" tools: if a tool's result describes mutable state
      // (e.g., preview_cart replaces the cart record — earlier previews in the
      // same turn describe data that no longer exists), keep only the final
      // entry per tool_name. Other tools emit-all (e.g., save_user_fact called
      // twice in parallel produces two legitimate events).
      const latestOnlyNames = new Set(
        this.toolRegistry
          .getAll()
          .filter((tool) => tool.emitLatestOnly === true)
          .map((tool) => tool.name),
      );

      const toolOutputs: WebChatToolOutput[] =
        latestOnlyNames.size === 0
          ? collected
          : (() => {
              const lastIndexByName = new Map<string, number>();

              collected.forEach((output, index) => {
                if (latestOnlyNames.has(output.tool_name)) {
                  lastIndexByName.set(output.tool_name, index);
                }
              });

              return collected.filter((output, index) => {
                if (!latestOnlyNames.has(output.tool_name)) {
                  return true;
                }

                return lastIndexByName.get(output.tool_name) === index;
              });
            })();

      return { reply: finalText, toolOutputs };
    } catch (error) {
      this.logger.error(`Failed to handle message [sessionUlid=${sessionUlid}]`, error);
      throw error;
    }
  }

  async getHistoryForClient(sessionUlid: string): Promise<WebChatHistoryMessage[]> {
    const table = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": sessionPk,
          ":skPrefix": MESSAGE_SK_PREFIX,
        },
        ScanIndexForward: true,
      }),
    );

    const items = result.Items ?? [];
    const history: WebChatHistoryMessage[] = [];

    for (const item of items) {
      const role = item.role;

      if (role !== "user" && role !== "assistant") {
        continue;
      }

      let blocks: ChatContentBlock[];

      try {
        blocks = JSON.parse(item.content);
      } catch {
        blocks = [{ type: "text", text: item.content }];
      }

      const textParts: string[] = [];

      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }

      const content = textParts.join("\n\n").trim();

      if (!content) {
        continue;
      }

      const rawSk = typeof item.SK === "string" ? item.SK : "";
      const id = rawSk.startsWith(MESSAGE_SK_PREFIX) ? rawSk.slice(MESSAGE_SK_PREFIX.length) : rawSk;

      history.push({
        id,
        role,
        content,
        timestamp: item._createdAt_,
      });
    }

    return history;
  }
}
