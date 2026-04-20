import { BadRequestException, Body, Controller, InternalServerErrorException, Logger, Post } from "@nestjs/common";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import { ChatSessionService } from "../services/chat-session.service";
import { IdentityService } from "../services/identity.service";
import { OriginAllowlistService } from "../services/origin-allowlist.service";
import { WebChatCreateSessionResponse, WebChatSendMessageResponse } from "../types/WebChat";
import { createSessionSchema, sendMessageSchema } from "../validation/web-chat.schema";
import type { CreateSessionBody, SendMessageBody } from "../validation/web-chat.schema";

@Controller("chat/web")
export class WebChatController {
  private readonly logger = new Logger(WebChatController.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly chatSessionService: ChatSessionService,
    private readonly agentRegistry: AgentRegistryService,
    private readonly originAllowlistService: OriginAllowlistService,
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

    const sessionUlid = await this.identityService.lookupOrCreateSession("web", body.guestUlid, body.agentName, accountUlid);
    const displayName = agent.displayName ?? agent.name;

    this.logger.debug(
      `Session created [agentName=${body.agentName} sessionUlid=${sessionUlid} accountUlid=${accountUlid} source=accountUlid]`,
    );

    return { sessionUlid, displayName };
  }

  @Post("messages")
  async sendMessage(
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageBody,
  ): Promise<WebChatSendMessageResponse> {
    const reply = await this.chatSessionService.handleMessage(body.sessionUlid, body.message);

    this.logger.debug(`Message handled [sessionUlid=${body.sessionUlid}]`);

    return { reply };
  }
}
