import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import configuration from "./config/configuration";
import { validate } from "./config/env.validation";
import { DatabaseConfigService } from "./services/database-config.service";
import { AnthropicConfigService } from "./services/anthropic-config.service";
import { DiscordConfigService } from "./services/discord-config.service";
import { SendGridConfigService } from "./services/sendgrid-config.service";
import { DynamoDBProvider } from "./providers/dynamodb.provider";
import { AnthropicService } from "./services/anthropic.service";
import { ChatSessionService } from "./services/chat-session.service";
import { DiscordService } from "./services/discord.service";
import { EmailService } from "./services/email.service";
import { IdentityService } from "./services/identity.service";
import { ToolRegistryService } from "./tools/tool-registry.service";
import { SaveUserFactTool } from "./tools/save-user-fact.tool";
import { CollectContactInfoTool } from "./tools/collect-contact-info.tool";
import { SendEmailTool } from "./tools/send-email.tool";
import { AgentRegistryService } from "./agents/agent-registry.service";
import { LeadCaptureAgent } from "./agents/lead-capture.agent";
import { EmailReplyService } from "./services/email-reply.service";
import { SendgridWebhookController } from "./controllers/sendgrid-webhook.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.APP_ENV || "local"}`, ".env"],
      load: [configuration],
      validate,
    }),
    DiscoveryModule,
  ],
  controllers: [AppController, SendgridWebhookController],
  providers: [
    AppService,
    DatabaseConfigService,
    AnthropicConfigService,
    DiscordConfigService,
    SendGridConfigService,
    DynamoDBProvider,
    AnthropicService,
    ChatSessionService,
    DiscordService,
    EmailService,
    IdentityService,
    SaveUserFactTool,
    CollectContactInfoTool,
    SendEmailTool,
    ToolRegistryService,
    LeadCaptureAgent,
    AgentRegistryService,
    EmailReplyService,
  ],
})
export class AppModule {}
