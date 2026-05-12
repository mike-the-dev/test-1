import { Body, Controller, Logger, Param, Post, UseGuards } from "@nestjs/common";

import { InternalAuthGuard } from "../guards/internal-auth.guard";
import { ReplyOrchestratorService } from "../services/reply-orchestrator.service";
import type { EmailFlushRequestBody } from "../types/EmailFlush";

@Controller("internal")
@UseGuards(InternalAuthGuard)
export class InternalEmailFlushController {
  private readonly logger = new Logger(InternalEmailFlushController.name);

  constructor(private readonly replyOrchestrator: ReplyOrchestratorService) {}

  @Post("email-flush/:sessionUlid")
  async handleEmailFlush(
    @Param("sessionUlid") sessionUlid: string,
    @Body() body: EmailFlushRequestBody,
  ): Promise<void> {
    this.logger.log(
      `[event=email_flush_received sessionUlid=${sessionUlid} bodySessionUlid=${body.sessionUlid}]`,
    );

    await this.replyOrchestrator.generateAndSendReply(sessionUlid, "email");
  }
}
