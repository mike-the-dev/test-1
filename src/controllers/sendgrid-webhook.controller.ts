import { Controller, Post, Body, UseInterceptors, Logger } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";

import type { EmailReplySendGridInboundFormFields } from "../types/EmailReply";
import { EmailReplyService } from "../services/email-reply.service";

@Controller("webhooks/sendgrid")
export class SendgridWebhookController {
  private readonly logger = new Logger(SendgridWebhookController.name);

  constructor(private readonly emailReplyService: EmailReplyService) {}

  @Post("inbound")
  @UseInterceptors(AnyFilesInterceptor())
  async handleInbound(@Body() body: EmailReplySendGridInboundFormFields): Promise<void> {
    this.logger.debug(`Received inbound webhook [contentLength=${JSON.stringify(body).length}]`);

    const outcome = await this.emailReplyService.processInboundReply(body);

    this.logger.log(`Inbound webhook handled [outcome=${outcome}]`);
  }
}
