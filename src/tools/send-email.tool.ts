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
    "Send an email to a user. Provide the recipient email, a clear subject, and an HTML body.";

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
        sessionUlid: context.sessionUlid,
      });

      this.logger.log(`Email sent [sessionUlid=${context.sessionUlid} messageId=${result.messageId}]`);

      return { result: `Email sent successfully. Message ID: ${result.messageId}` };
    } catch (error) {
      const errorRecord: { name?: unknown; message?: unknown } = error !== null && error !== undefined ? error : {};
      const errorName = String(errorRecord.name ?? "unknown");
      const errorMessage = String(errorRecord.message ?? "unknown error");

      this.logger.error(`send_email failed [sessionUlid=${context.sessionUlid} errorType=${errorName}]`);

      return { result: `Failed to send email: ${errorMessage}`, isError: true };
    }
  }
}
