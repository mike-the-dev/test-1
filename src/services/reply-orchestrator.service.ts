import { Inject, Injectable, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { AnthropicService } from "./anthropic.service";
import { DatabaseConfigService } from "./database-config.service";
import { ToolRegistryService } from "../tools/tool-registry.service";
import { AgentRegistryService } from "../agents/agent-registry.service";
import { EmailService } from "./email.service";
import { SmsService } from "./sms.service";
import { SCHEDULER_SERVICE } from "../types/Scheduler";
import type { ISchedulerService } from "../types/Scheduler";
import { ChatSessionNewMessage, ChatSessionMessageRecord } from "../types/ChatSession";
import { ChatContentBlock, ChatToolResultContentBlock, ChatToolUseContentBlock } from "../types/ChatContent";
import { WebChatToolOutput } from "../types/WebChat";
import { ReplyOrchestratorChannel, ReplyOrchestratorOutcome, ReplyOrchestratorSendContext } from "../types/ReplyOrchestrator";
import { wrapInHtml } from "../utils/email/wrap-in-html";
import { getChannelFormatRules } from "../agents/channel-format-rules";

const MAX_TOOL_LOOP_ITERATIONS = 10;
const MAX_HISTORY_MESSAGES = 50;
const PRIOR_HISTORY_MESSAGE_LIMIT = 20;
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const MESSAGE_SK_PREFIX = "MESSAGE#";
const METADATA_SK = "METADATA";
const CONTACT_INFO_SK = "USER_CONTACT_INFO";
const DEFAULT_AGENT_NAME = "lead_capture";
const SESSION_KICKOFF_MARKER = "__SESSION_KICKOFF__";

function buildContinuationContextBlock(profile: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
}): string {
  const phone = profile.phone ?? "not provided";

  return [
    "The visitor you're talking to is a returning customer:",
    `- Name: ${profile.firstName} ${profile.lastName}`,
    `- Email: ${profile.email}`,
    `- Phone: ${phone}`,
    "",
    "They were just verified. The conversation messages below begin with their prior session, then continue with today's session. Briefly acknowledge what you were working on together before answering their current question.",
  ].join("\n");
}

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
export class ReplyOrchestratorService {
  private readonly logger = new Logger(ReplyOrchestratorService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly anthropicService: AnthropicService,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly agentRegistry: AgentRegistryService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    @Inject(SCHEDULER_SERVICE) private readonly schedulerService: ISchedulerService,
  ) {}

  async generateAndSendReply(
    sessionUlid: string,
    channel: ReplyOrchestratorChannel,
    sendContext?: ReplyOrchestratorSendContext,
  ): Promise<ReplyOrchestratorOutcome> {
    try {
      const table = this.databaseConfig.conversationsTable;
      const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

      this.logger.log(
        `[event=reply_orchestrator_start sessionUlid=${sessionUlid} channel=${channel}]`,
      );

      // Step 1 — Load METADATA
      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: table,
          Key: { PK: sessionPk, SK: METADATA_SK },
        }),
      );

      const rawAgentName: string | undefined = metadataResult.Item?.agent_name;
      const storedAgentName = rawAgentName ?? DEFAULT_AGENT_NAME;

      const rawAccountId: string | undefined = metadataResult.Item?.account_id;
      let accountUlid: string | undefined;

      if (rawAccountId !== undefined) {
        accountUlid = rawAccountId.startsWith("A#") ? rawAccountId.slice(2) : rawAccountId;
      }

      const onboardingData: Record<string, unknown> | undefined = metadataResult.Item?.onboarding_data;
      const rawBudget = onboardingData?.budgetCents;
      const budgetCents =
        rawBudget !== undefined && rawBudget !== null && !Number.isNaN(Number(rawBudget))
          ? Number(rawBudget)
          : undefined;

      const customerId: string | null = metadataResult.Item?.customer_id ?? null;

      const fromName = metadataResult.Item?.from_name
        ? String(metadataResult.Item.from_name)
        : null;

      // Step 2 — Resolve agent
      let resolvedAgent = this.agentRegistry.getByName(storedAgentName);

      if (resolvedAgent === null) {
        this.logger.warn(
          `Agent not found, falling back to default [sessionUlid=${sessionUlid} agentName=${storedAgentName}]`,
        );
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

      this.logger.log(
        `Agent resolved [sessionUlid=${sessionUlid} agentName=${agent.name} toolCount=${filteredDefinitions.length}]`,
      );

      // Step 3 — Load history
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

      // Step 4 — Find outstanding user messages (after last assistant reply)
      const historyRoles = history.map((msg) => msg.role);
      const lastAssistantIndex = historyRoles.lastIndexOf("assistant");

      const historyAfterAssistant = lastAssistantIndex === -1 ? history : history.slice(lastAssistantIndex + 1);
      const outstandingMessages = historyAfterAssistant.filter((msg) => msg.role === "user");

      // Step 5 — No-op if nothing outstanding
      if (outstandingMessages.length === 0) {
        this.logger.log(
          `[event=reply_orchestrator_no_op_no_outstanding sessionUlid=${sessionUlid} channel=${channel}]`,
        );

        try {
          await this.schedulerService.cancelEmailFlush(sessionUlid);
        } catch (cancelError: unknown) {
          const errorName = cancelError instanceof Error ? cancelError.name : "UnknownError";
          this.logger.error(
            `[event=reply_orchestrator_cancel_failed sessionUlid=${sessionUlid} errorType=${errorName}]`,
          );
        }

        return { outcome: "no_op_nothing_outstanding" };
      }

      try {
        this.logger.log(
          `[event=reply_orchestrator_outstanding sessionUlid=${sessionUlid} channel=${channel} count=${outstandingMessages.length}]`,
        );

        // Step 5b — Kickoff replay: if the last outstanding message is the kickoff marker
        // AND the session has already completed a kickoff, return the stored welcome without
        // calling the LLM (handles web reconnect after page reload).
        const lastOutstanding = outstandingMessages[outstandingMessages.length - 1];
        const lastOutstandingText =
          lastOutstanding?.content[0]?.type === "text" ? lastOutstanding.content[0].text : "";
        const isKickoff = lastOutstandingText === SESSION_KICKOFF_MARKER;
        const existingKickoffCompletedAt: string | undefined = metadataResult.Item?.kickoff_completed_at;

        if (isKickoff && existingKickoffCompletedAt) {
          const replayItems = (await this.dynamoDb.send(
            new QueryCommand({
              TableName: table,
              KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
              ExpressionAttributeValues: { ":pk": sessionPk, ":skPrefix": MESSAGE_SK_PREFIX },
              ScanIndexForward: true,
            }),
          )).Items ?? [];

          const kickoffUserIndex = replayItems.findIndex((messageItem) => {
            if (messageItem.role !== "user") return false;

            try {
              const blocks: ChatContentBlock[] = JSON.parse(messageItem.content);
              return blocks.some((block) => block.type === "text" && block.text === SESSION_KICKOFF_MARKER);
            } catch {
              return messageItem.content === SESSION_KICKOFF_MARKER;
            }
          });

          const storedWelcome = kickoffUserIndex !== -1
            ? replayItems.slice(kickoffUserIndex + 1).find((messageItem) => messageItem.role === "assistant")
            : undefined;

          if (!storedWelcome) {
            this.logger.warn(`Kickoff replay found no stored welcome [sessionUlid=${sessionUlid}]`);
            return { outcome: "replied", reply: "", toolOutputs: [] };
          }

          let welcomeBlocks: ChatContentBlock[];

          try {
            welcomeBlocks = JSON.parse(storedWelcome.content);
          } catch {
            welcomeBlocks = [{ type: "text", text: storedWelcome.content }];
          }

          const replayTextParts: string[] = [];

          for (const block of welcomeBlocks) {
            if (block.type === "text" && block.text) {
              replayTextParts.push(block.text);
            }
          }

          const replayText = replayTextParts.join("\n\n").trim();

          this.logger.debug(
            `Kickoff replay served from history [sessionUlid=${sessionUlid} kickoffCompletedAt=${existingKickoffCompletedAt}]`,
          );

          return { outcome: "replied", reply: replayText, toolOutputs: [] };
        }

        // Step 6 — Build messages array (full history + no new user message — history already has outstanding)
        const messages = [...history];
        const newMessages: ChatSessionNewMessage[] = [];

        // Step 7 — Prior-history loader
        const budgetContext =
          budgetCents !== undefined && budgetCents !== null
            ? `User context: shopping budget is approximately $${Math.floor(budgetCents / 100)}.`
            : undefined;

        let dynamicSystemContext = budgetContext;

        const continuationFromSessionId: string | null =
          metadataResult.Item?.continuation_from_session_id ?? null;
        const continuationLoadedAt: string | null =
          metadataResult.Item?.continuation_loaded_at ?? null;

        const shouldLoadContinuation =
          continuationFromSessionId !== null && continuationLoadedAt === null;

        if (shouldLoadContinuation) {
          try {
            const priorSessionPk = continuationFromSessionId!.startsWith(CHAT_SESSION_PK_PREFIX)
              ? continuationFromSessionId!
              : `${CHAT_SESSION_PK_PREFIX}${continuationFromSessionId}`;

            const rawCustomerId = customerId ?? "";
            const customerKey = rawCustomerId.startsWith("C#") ? rawCustomerId : `C#${rawCustomerId}`;

            const [customerResult, priorHistoryResult] = await Promise.all([
              this.dynamoDb.send(
                new GetCommand({
                  TableName: table,
                  Key: { PK: customerKey, SK: customerKey },
                }),
              ),
              this.dynamoDb.send(
                new QueryCommand({
                  TableName: table,
                  KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
                  ExpressionAttributeValues: {
                    ":pk": priorSessionPk,
                    ":skPrefix": MESSAGE_SK_PREFIX,
                  },
                  ScanIndexForward: false,
                  Limit: PRIOR_HISTORY_MESSAGE_LIMIT,
                }),
              ),
            ]);

            if (!customerResult.Item) {
              this.logger.warn(
                `[event=continuation_loader_customer_not_found sessionUlid=${sessionUlid}]`,
              );
            }

            if (customerResult.Item) {
              const customerProfile = customerResult.Item;

              const priorItems = priorHistoryResult.Items ?? [];
              const priorItemsChronological = [...priorItems].reverse();

              const priorMessagesChronological = priorItemsChronological.map((item): ChatSessionNewMessage => {
                const rawContent = item.content;
                const role = item.role;

                try {
                  const parsed: ChatContentBlock[] = JSON.parse(rawContent);
                  return { role, content: parsed };
                } catch {
                  return { role, content: [{ type: "text", text: rawContent }] };
                }
              });

              messages.unshift(...priorMessagesChronological);

              const continuationContextBlock = buildContinuationContextBlock({
                firstName: String(customerProfile.first_name ?? ""),
                lastName: String(customerProfile.last_name ?? ""),
                email: String(customerProfile.email ?? ""),
                phone: customerProfile.phone != null ? String(customerProfile.phone) : null,
              });

              dynamicSystemContext = budgetContext
                ? `${budgetContext}\n\n${continuationContextBlock}`
                : continuationContextBlock;

              this.logger.log(
                `[event=continuation_loaded sessionUlid=${sessionUlid} priorCount=${priorMessagesChronological.length}]`,
              );

              const loaderTimestamp = new Date().toISOString();

              try {
                await this.dynamoDb.send(
                  new UpdateCommand({
                    TableName: table,
                    Key: { PK: sessionPk, SK: METADATA_SK },
                    UpdateExpression:
                      "SET continuation_loaded_at = if_not_exists(continuation_loaded_at, :now), #lastUpdated = :now",
                    ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
                    ExpressionAttributeValues: { ":now": loaderTimestamp },
                  }),
                );
              } catch (flagError: unknown) {
                const errorName = flagError instanceof Error ? flagError.name : "UnknownError";

                this.logger.warn(
                  `[event=continuation_flag_write_failed errorType=${errorName} sessionUlid=${sessionUlid}]`,
                );
              }
            }
          } catch (loaderError: unknown) {
            const errorName = loaderError instanceof Error ? loaderError.name : "UnknownError";

            this.logger.warn(
              `[event=continuation_load_failed errorType=${errorName} sessionUlid=${sessionUlid}]`,
            );
          }
        }

        // Step 8 — Append channel format rules to dynamic system context
        const channelFormatRules = getChannelFormatRules(channel, fromName);
        dynamicSystemContext = dynamicSystemContext
          ? `${dynamicSystemContext}\n\n${channelFormatRules}`
          : channelFormatRules;

        // Step 9 — LLM tool loop
        let iteration = 0;

        while (iteration < MAX_TOOL_LOOP_ITERATIONS) {
          iteration++;

          this.logger.log(
            `Calling Anthropic [sessionUlid=${sessionUlid} iteration=${iteration} historySize=${messages.length}]`,
          );

          const response = await this.anthropicService.sendMessage(
            [...messages],
            filteredDefinitions,
            agent.systemPrompt,
            dynamicSystemContext,
          );

          const assistantMsg = buildAssistantMessage(response.content);

          messages.push(assistantMsg);
          newMessages.push(assistantMsg);

          if (response.stop_reason === "end_turn") {
            this.logger.log(`Tool loop complete [sessionUlid=${sessionUlid} iterations=${iteration}]`);
            break;
          }

          if (response.stop_reason !== "tool_use") {
            this.logger.warn(
              `Unexpected stop_reason [sessionUlid=${sessionUlid} stop_reason=${response.stop_reason}]`,
            );
            break;
          }

          const toolUseBlocks: ChatToolUseContentBlock[] = [];

          for (const block of response.content) {
            if (block.type === "tool_use") {
              toolUseBlocks.push(block);
            }
          }

          this.logger.log(
            `Tool use detected [sessionUlid=${sessionUlid} count=${toolUseBlocks.length}]`,
          );

          const toolResultBlocks = await Promise.all(
            toolUseBlocks.map(async (block) => {
              if (!agent.allowedToolNames.includes(block.name)) {
                this.logger.warn(
                  `Tool not in agent allowlist [sessionUlid=${sessionUlid} agentName=${agent.name} toolName=${block.name}]`,
                );

                return buildToolResultBlock(block.id, `Tool not available for this agent: ${block.name}`, true);
              }

              const executionResult = await this.toolRegistry.execute(block.name, block.input, {
                sessionUlid,
                accountUlid,
              });

              return buildToolResultBlock(block.id, executionResult.result, executionResult.isError);
            }),
          );

          const toolResultMsg = buildToolResultMessage(toolResultBlocks);

          messages.push(toolResultMsg);
          newMessages.push(toolResultMsg);
        }

        if (iteration >= MAX_TOOL_LOOP_ITERATIONS) {
          this.logger.warn(`Tool loop max iterations reached [sessionUlid=${sessionUlid}]`);
        }

        // Step 10 — Persist new messages
        const now = new Date().toISOString();

        for (const message of newMessages) {
          const baseItem: ChatSessionMessageRecord = {
            PK: sessionPk,
            SK: `${MESSAGE_SK_PREFIX}${ulid()}`,
            role: message.role,
            content: JSON.stringify(message.content),
            _createdAt_: now,
          };

          if (message.role === "assistant") {
            baseItem.channel = channel;
          }

          await this.dynamoDb.send(
            new PutCommand({
              TableName: table,
              Item: baseItem,
            }),
          );
        }

        // Step 11 — Update METADATA _lastUpdated_
        await this.dynamoDb.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: sessionPk, SK: METADATA_SK },
            UpdateExpression: "SET #createdAt = if_not_exists(#createdAt, :now), #lastUpdated = :now",
            ExpressionAttributeNames: { "#createdAt": "_createdAt_", "#lastUpdated": "_lastUpdated_" },
            ExpressionAttributeValues: { ":now": now },
          }),
        );

        // Step 11b — Stamp kickoff_completed_at on first kickoff completion
        if (isKickoff) {
          try {
            await this.dynamoDb.send(
              new UpdateCommand({
                TableName: table,
                Key: { PK: sessionPk, SK: METADATA_SK },
                UpdateExpression: "SET kickoff_completed_at = if_not_exists(kickoff_completed_at, :now)",
                ExpressionAttributeValues: { ":now": now },
              }),
            );
          } catch (stampError: unknown) {
            const errorName = stampError instanceof Error ? stampError.name : "UnknownError";

            this.logger.warn(
              `Failed to stamp kickoff_completed_at [errorType=${errorName} sessionUlid=${sessionUlid}]`,
            );
          }
        }

        // Step 12 — Update account-scoped session pointer best-effort
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
          } catch (pointerError: unknown) {
            const errorName = pointerError instanceof Error ? pointerError.name : "UnknownError";

            if (errorName !== "ConditionalCheckFailedException") {
              this.logger.warn(
                `Session pointer lastMessageAt update failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
              );
            }
          }
        }

        // Step 13 — Update customer latest_session_id best-effort
        if (customerId !== null) {
          try {
            const customerKey = customerId.startsWith("C#") ? customerId : `C#${customerId}`;

            await this.dynamoDb.send(
              new UpdateCommand({
                TableName: table,
                Key: { PK: customerKey, SK: customerKey },
                UpdateExpression: "SET latest_session_id = :sessionUlid, #lastUpdated = :now",
                ConditionExpression: "attribute_exists(PK)",
                ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
                ExpressionAttributeValues: {
                  ":sessionUlid": `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
                  ":now": now,
                },
              }),
            );
          } catch (latestSessionError: unknown) {
            const errorName = latestSessionError instanceof Error ? latestSessionError.name : "UnknownError";

            if (errorName !== "ConditionalCheckFailedException") {
              this.logger.warn(
                `latest_session_id update failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
              );
            }
          }
        }

        // Step 14 — Extract reply text and tool outputs
        const assistantMessagesThisTurn = newMessages.filter((message) => message.role === "assistant");
        const lastAssistantMsg = assistantMessagesThisTurn[assistantMessagesThisTurn.length - 1];

        const textParts: string[] = [];

        if (lastAssistantMsg) {
          for (const block of lastAssistantMsg.content) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
            }
          }
        }

        const finalText = textParts.join("\n\n").trim();

        if (!finalText) {
          this.logger.warn(
            `No text blocks across any assistant messages this turn [sessionUlid=${sessionUlid}]`,
          );
        }

        const toolUseNamesById = new Map<string, string>();

        for (const assistantMsg of assistantMessagesThisTurn) {
          for (const block of assistantMsg.content) {
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

            collected.push({
              call_id: block.tool_use_id,
              tool_name: toolName,
              content: block.content,
              ...(block.is_error === true ? { is_error: true } : {}),
            });
          }
        }

        const allTools = this.toolRegistry.getAll();
        const latestOnlyTools = allTools.filter((tool) => tool.emitLatestOnly === true);
        const latestOnlyNames = new Set(latestOnlyTools.map((tool) => tool.name));

        let toolOutputs = collected;

        if (latestOnlyNames.size > 0) {
          const lastIndexByName = new Map<string, number>();

          collected.forEach((output, index) => {
            if (latestOnlyNames.has(output.tool_name)) {
              lastIndexByName.set(output.tool_name, index);
            }
          });

          toolOutputs = collected.filter((output, index) => {
            if (!latestOnlyNames.has(output.tool_name)) {
              return true;
            }

            return lastIndexByName.get(output.tool_name) === index;
          });
        }

        // Step 15 — Send outbound reply via the channel
        await this.sendOutbound(sessionUlid, channel, finalText, sendContext, metadataResult.Item);

        this.logger.log(
          `[event=reply_orchestrator_complete sessionUlid=${sessionUlid} channel=${channel}]`,
        );

        return { outcome: "replied", reply: finalText, toolOutputs };
      } finally {
        // Step 16 — Cancel any pending email schedule (always fires, all channels, success or failure)
        try {
          await this.schedulerService.cancelEmailFlush(sessionUlid);
        } catch (cancelError: unknown) {
          const errorName = cancelError instanceof Error ? cancelError.name : "UnknownError";
          this.logger.error(
            `[event=reply_orchestrator_cancel_failed sessionUlid=${sessionUlid} errorType=${errorName}]`,
          );
        }
      }
    } catch (error: unknown) {
      this.logger.error(
        `Failed to generate and send reply [sessionUlid=${sessionUlid} channel=${channel}]`,
        error,
      );
      throw error;
    }
  }

  private async sendOutbound(
    sessionUlid: string,
    channel: ReplyOrchestratorChannel,
    replyText: string,
    sendContext: ReplyOrchestratorSendContext | undefined,
    metadataItem: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (channel === "web") {
      return;
    }

    if (channel === "sms") {
      if (!sendContext?.sms) {
        this.logger.warn(
          `[event=reply_orchestrator_sms_no_context sessionUlid=${sessionUlid}]`,
        );
        return;
      }

      await this.smsService.send({
        to: sendContext.sms.to,
        from: sendContext.sms.from,
        body: replyText,
        sessionUlid,
      });

      return;
    }

    if (channel === "email") {
      const table = this.databaseConfig.conversationsTable;
      const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

      const contactResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: table,
          Key: { PK: sessionPk, SK: CONTACT_INFO_SK },
        }),
      );

      const recipientEmailRaw = contactResult.Item?.email;
      const recipientEmail = recipientEmailRaw ? String(recipientEmailRaw) : undefined;

      if (!recipientEmail) {
        this.logger.warn(`[event=email_flush_no_recipient sessionUlid=${sessionUlid}]`);
        return;
      }

      const rawInboundMessageId = metadataItem?.last_inbound_email_message_id
        ? String(metadataItem.last_inbound_email_message_id)
        : undefined;
      const rawInboundSubject = metadataItem?.last_inbound_email_subject
        ? String(metadataItem.last_inbound_email_subject)
        : undefined;
      const rawReplyDomain = metadataItem?.reply_domain
        ? String(metadataItem.reply_domain)
        : undefined;
      const rawFromName = metadataItem?.from_name
        ? String(metadataItem.from_name)
        : undefined;

      if (!rawInboundMessageId || !rawInboundSubject) {
        this.logger.error(
          `[event=email_flush_missing_threading_context sessionUlid=${sessionUlid}]`,
        );

        await this.emailService.send({
          to: recipientEmail,
          subject: "Re: your message",
          body: wrapInHtml(replyText),
          sessionUlid,
          replyDomain: rawReplyDomain,
          fromName: rawFromName,
        });

        return;
      }

      const replySubject = rawInboundSubject.startsWith("Re:")
        ? rawInboundSubject
        : `Re: ${rawInboundSubject}`;

      await this.emailService.send({
        to: recipientEmail,
        subject: replySubject,
        body: wrapInHtml(replyText),
        sessionUlid,
        inReplyToMessageId: rawInboundMessageId,
        referencesMessageId: rawInboundMessageId,
        replyDomain: rawReplyDomain,
        fromName: rawFromName,
      });
    }
  }
}
