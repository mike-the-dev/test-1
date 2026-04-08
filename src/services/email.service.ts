import { Injectable, Logger } from "@nestjs/common";
import sgMail from "@sendgrid/mail";

import { SendGridConfigService } from "./sendgrid-config.service";
import { EmailSendParams, EmailSendResult } from "../types/Email";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly sendGridConfig: SendGridConfigService) {
    sgMail.setApiKey(this.sendGridConfig.apiKey);
  }

  async send(params: EmailSendParams): Promise<EmailSendResult> {
    const message = {
      from: {
        email: this.sendGridConfig.fromEmail,
        name: this.sendGridConfig.fromName,
      },
      to: params.to,
      subject: params.subject,
      html: params.body,
    };

    try {
      const [response] = await sgMail.send(message);

      const messageId = response.headers["x-message-id"] || "";

      this.logger.log(`Email sent successfully [messageId=${messageId}]`);

      return { messageId };
    } catch (error) {
      this.logger.error(
        `Email send failed [errorType=${error instanceof Error ? error.name : "unknown"}]`,
      );
      throw error;
    }
  }
}
