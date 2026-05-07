import { Injectable, Logger } from "@nestjs/common";
import sgMail from "@sendgrid/mail";

import { SendGridConfigService } from "./sendgrid-config.service";
import { EmailSendParams, EmailSendResult, EmailOutboundMessage, EmailSendGridSdkError } from "../types/Email";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly sendGridConfig: SendGridConfigService) {
    sgMail.setApiKey(this.sendGridConfig.apiKey);
  }

  async send(params: EmailSendParams): Promise<EmailSendResult> {
    if (!params.replyDomain) {
      // Tool-originated send (no account context). Log a warn and send without a custom
      // from address — SendGrid will use the account-level verified sender on the API key.
      this.logger.warn(
        `[event=email_send_no_reply_domain sessionUlid=${params.sessionUlid}]`,
      );
    }

    const fromEmail = params.replyDomain ? `${params.sessionUlid}@${params.replyDomain}` : "";
    const fromName = params.replyDomain ? (params.fromName ?? "") : "";

    const message: EmailOutboundMessage = {
      from: {
        email: fromEmail,
        name: fromName,
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
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        this.logger.error("Email send failed [errorType=unknown]");
        throw error;
      }

      const sdkError: EmailSendGridSdkError = error;
      const errorName = sdkError.name;
      const statusCode = String(sdkError.code ?? "unknown");
      const responseBody = sdkError.response?.body ? JSON.stringify(sdkError.response.body) : "none";

      this.logger.error(`Email send failed [errorType=${errorName} statusCode=${statusCode} response=${responseBody}]`);

      throw error;
    }
  }
}
