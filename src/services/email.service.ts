import { Injectable, Logger } from "@nestjs/common";
import sgMail from "@sendgrid/mail";

import { SendGridConfigService } from "./sendgrid-config.service";
import { EmailSendParams, EmailSendResult, EmailOutboundMessage } from "../types/Email";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly sendGridConfig: SendGridConfigService) {
    sgMail.setApiKey(this.sendGridConfig.apiKey);
  }

  async send(params: EmailSendParams): Promise<EmailSendResult> {
    const replyDomain = this.sendGridConfig.replyDomain;
    const fromEmail = replyDomain ? `${params.sessionUlid}@${replyDomain}` : this.sendGridConfig.fromEmail;

    if (!replyDomain) {
      this.logger.warn(
        `SENDGRID_REPLY_DOMAIN not set — falling back to verified sender. Inbound reply routing is disabled until set. [sessionUlid=${params.sessionUlid}]`,
      );
    }

    const message: EmailOutboundMessage = {
      from: {
        email: fromEmail,
        name: this.sendGridConfig.fromName,
      },
      to: params.to,
      subject: params.subject,
      html: params.body,
    };

    if (params.inReplyToMessageId) {
      message.headers = {
        "In-Reply-To": `<${params.inReplyToMessageId}>`,
        References: `<${params.referencesMessageId ?? params.inReplyToMessageId}>`,
      };
    }

    try {
      const [response] = await sgMail.send(message);

      const messageId = response.headers["x-message-id"] || "";

      this.logger.log(`Email sent successfully [messageId=${messageId}]`);

      return { messageId };
    } catch (error) {
      const errorRecord: { name?: unknown; code?: unknown; response?: { body?: unknown } } =
        error !== null && error !== undefined ? error : {};
      const errorName = String(errorRecord.name ?? "unknown");
      const statusCode = String(errorRecord.code ?? "unknown");
      const responseBody = errorRecord.response?.body ? JSON.stringify(errorRecord.response.body) : "none";

      this.logger.error(`Email send failed [errorType=${errorName} statusCode=${statusCode} response=${responseBody}]`);

      throw error;
    }
  }
}
