import { Injectable, Logger } from "@nestjs/common";

import { EmailService } from "../services/email.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { sendEmailInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

@ChatToolProvider()
@Injectable()
export class SendEmailTool implements ChatTool {
  private readonly logger = new Logger(SendEmailTool.name);

  readonly name = "send_email";

  readonly description =
    "Send an email to a user. Use this only after you have collected the user's email address (e.g. via collect_contact_info) and confirmed they want to receive an email. Provide the recipient email, a clear subject, and an HTML body. Do not use this tool without explicit user consent.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {
      to: {
        type: "string",
        format: "email",
        description: "The recipient's email address",
      },
      subject: {
        type: "string",
        description: "The email subject line",
      },
      body: {
        type: "string",
        description: "The HTML body of the email",
      },
    },
    required: ["to", "subject", "body"],
  };

  constructor(private readonly emailService: EmailService) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    this.logger.debug(`Executing tool [name=send_email sessionUlid=${context.sessionUlid}]`);

    const parseResult = sendEmailInputSchema.safeParse(input);

    if (!parseResult.success) {
      return { result: `Invalid input: ${parseResult.error.message}`, isError: true };
    }

    try {
      const result = await this.emailService.send({
        to: parseResult.data.to,
        subject: parseResult.data.subject,
        body: parseResult.data.body,
      });

      this.logger.log(`Email sent [sessionUlid=${context.sessionUlid} messageId=${result.messageId}]`);

      return { result: `Email sent successfully. Message ID: ${result.messageId}` };
    } catch (error) {
      this.logger.error(
        `send_email failed [sessionUlid=${context.sessionUlid} errorType=${error instanceof Error ? error.name : "unknown"}]`,
      );

      const message = error instanceof Error ? error.message : "unknown error";

      return { result: `Failed to send email: ${message}`, isError: true };
    }
  }
}
