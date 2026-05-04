import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import { ChatSessionService } from "../services/chat-session.service";
import { SessionService } from "../services/session.service";
import { OriginAllowlistService } from "../services/origin-allowlist.service";
import { SlackAlertService } from "../services/slack-alert.service";
import {
  WebChatCreateSessionResponse,
  WebChatEmbedAuthorizeResponse,
  WebChatMessagesResponse,
  WebChatOnboardingResponse,
  WebChatSendMessageResponse,
} from "../types/WebChat";
import {
  createSessionSchema,
  embedAuthorizeSchema,
  onboardingSchema,
  sendMessageSchema,
  sessionIdParamSchema,
} from "../validation/web-chat.schema";
import type { CreateSessionBody, EmbedAuthorizeBody, OnboardingBody, SendMessageBody } from "../validation/web-chat.schema";

@Controller("chat/web")
export class WebChatController {
  private readonly logger = new Logger(WebChatController.name);

  constructor(
    private readonly sessionService: SessionService,
    private readonly chatSessionService: ChatSessionService,
    private readonly agentRegistry: AgentRegistryService,
    private readonly originAllowlistService: OriginAllowlistService,
    private readonly slackAlertService: SlackAlertService,
  ) {}

  @Post("sessions")
  async createSession(
    @Body(new ZodValidationPipe(createSessionSchema)) body: CreateSessionBody,
  ): Promise<WebChatCreateSessionResponse> {
    const agent = this.agentRegistry.getByName(body.agentName);

    if (agent === null) {
      throw new BadRequestException(`Unknown agent: ${body.agentName}`);
    }

    // Schema guarantees body.accountUlid matches /^A#<26-char-ulid>$/; strip
    // the "A#" so downstream services receive the raw ULID. The prefix exists
    // only in the embed snippet and on the wire.
    const rawAccountUlid = body.accountUlid.slice(2);

    const accountUlid = await this.originAllowlistService.verifyAccountActive(rawAccountUlid);

    if (accountUlid === null) {
      throw new InternalServerErrorException("Unable to resolve account for request.");
    }

    const sessionResult = await this.sessionService.lookupOrCreateSession(
      "web",
      body.sessionId ?? null,
      body.agentName,
      accountUlid,
    );

    if (sessionResult.wasCreated) {
      this.slackAlertService.notifyConversationStarted({
        accountId: accountUlid,
        sessionUlid: sessionResult.sessionUlid,
      }).catch(() => undefined);
    }

    const displayName = agent.displayName ?? agent.name;

    return {
      sessionId: sessionResult.sessionUlid,
      displayName,
      onboardingCompletedAt: sessionResult.onboardingCompletedAt,
      kickoffCompletedAt: sessionResult.kickoffCompletedAt,
      budgetCents: sessionResult.budgetCents,
    };
  }

  @Post("sessions/:sessionId/onboarding")
  async completeOnboarding(
    @Param("sessionId", new ZodValidationPipe(sessionIdParamSchema)) sessionUlid: string,
    @Body(new ZodValidationPipe(onboardingSchema)) body: OnboardingBody,
  ): Promise<WebChatOnboardingResponse> {
    try {
      const result = await this.sessionService.updateOnboarding(sessionUlid, body.budgetCents);

      this.logger.debug(`Onboarding completed [sessionUlid=${sessionUlid} budgetCents=${body.budgetCents}]`);

      return {
        sessionId: result.sessionUlid,
        onboardingCompletedAt: result.onboardingCompletedAt,
        kickoffCompletedAt: result.kickoffCompletedAt,
        budgetCents: result.budgetCents,
      };
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";

      if (errorName === "ConditionalCheckFailedException") {
        throw new NotFoundException(`Session not found: ${sessionUlid}`);
      }

      this.logger.error(`Onboarding update failed [sessionUlid=${sessionUlid} errorType=${errorName}]`);
      throw new InternalServerErrorException("Failed to record onboarding.");
    }
  }

  @Get("sessions/:sessionId/messages")
  async getMessages(
    @Param("sessionId", new ZodValidationPipe(sessionIdParamSchema)) sessionUlid: string,
  ): Promise<WebChatMessagesResponse> {
    const messages = await this.chatSessionService.getHistoryForClient(sessionUlid);
    return { messages };
  }

  @Post("embed/authorize")
  async embedAuthorize(
    @Body(new ZodValidationPipe(embedAuthorizeSchema)) body: EmbedAuthorizeBody,
  ): Promise<WebChatEmbedAuthorizeResponse> {
    const rawAccountUlid = body.accountUlid.slice(2);
    const authorized = await this.originAllowlistService.isOriginAuthorizedForAccount(rawAccountUlid, body.parentDomain);
    return { authorized };
  }

  @Post("messages")
  async sendMessage(
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageBody,
  ): Promise<WebChatSendMessageResponse> {
    const { reply, toolOutputs } = await this.chatSessionService.handleMessage(body.sessionId, body.message);

    this.logger.debug(
      `Message handled [sessionUlid=${body.sessionId} toolOutputCount=${toolOutputs.length}]`,
    );

    return toolOutputs.length > 0 ? { reply, tool_outputs: toolOutputs } : { reply };
  }
}
