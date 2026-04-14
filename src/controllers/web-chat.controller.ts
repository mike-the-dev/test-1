import { BadRequestException, Body, Controller, Logger, Post } from "@nestjs/common";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import { ChatSessionService } from "../services/chat-session.service";
import { IdentityService } from "../services/identity.service";
import { WebChatCreateSessionResponse, WebChatSendMessageResponse } from "../types/WebChat";
import { createSessionSchema, sendMessageSchema, CreateSessionBody, SendMessageBody } from "../validation/web-chat.schema";

@Controller("chat/web")
export class WebChatController {
  private readonly logger = new Logger(WebChatController.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly chatSessionService: ChatSessionService,
    private readonly agentRegistry: AgentRegistryService,
  ) {}

  @Post("sessions")
  async createSession(
    @Body(new ZodValidationPipe(createSessionSchema)) body: CreateSessionBody,
  ): Promise<WebChatCreateSessionResponse> {
    const agent = this.agentRegistry.getByName(body.agentName);

    if (agent === null) {
      throw new BadRequestException(`Unknown agent: ${body.agentName}`);
    }

    const sessionUlid = await this.identityService.lookupOrCreateSession("web", body.guestUlid, body.agentName);
    const displayName = agent.displayName ?? agent.name;

    this.logger.debug(`Session created [agentName=${body.agentName} sessionUlid=${sessionUlid}]`);

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
