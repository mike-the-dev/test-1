import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import configuration from "./config/configuration";
import { validate } from "./config/env.validation";
import { DatabaseConfigService } from "./services/database-config.service";
import { QdrantConfigService } from "./services/qdrant-config.service";
import { AnthropicConfigService } from "./services/anthropic-config.service";
import { VoyageConfigService } from "./services/voyage-config.service";
import { VoyageService } from "./services/voyage.service";
import { DiscordConfigService } from "./services/discord-config.service";
import { SendGridConfigService } from "./services/sendgrid-config.service";
import { DynamoDBProvider } from "./providers/dynamodb.provider";
import { QdrantProvider } from "./providers/qdrant.provider";
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
import { ShoppingAssistantAgent } from "./agents/shopping-assistant.agent";
import { ListServicesTool } from "./tools/list-services.tool";
import { LookupKnowledgeBaseTool } from "./tools/lookup-knowledge-base.tool";
import { PreviewCartTool } from "./tools/preview-cart.tool";
import { GenerateCheckoutLinkTool } from "./tools/generate-checkout-link.tool";
import { EmailReplyService } from "./services/email-reply.service";
import { KnowledgeBaseController } from "./controllers/knowledge-base.controller";
import { SendgridWebhookController } from "./controllers/sendgrid-webhook.controller";
import { WebChatController } from "./controllers/web-chat.controller";
import { KnowledgeBaseEnrichmentService } from "./services/knowledge-base-enrichment.service";
import { KnowledgeBaseIngestionService } from "./services/knowledge-base-ingestion.service";
import { OriginAllowlistService } from "./services/origin-allowlist.service";

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
  controllers: [AppController, SendgridWebhookController, WebChatController, KnowledgeBaseController],
  providers: [
    AppService,
    DatabaseConfigService,
    QdrantConfigService,
    AnthropicConfigService,
    VoyageConfigService,
    DiscordConfigService,
    SendGridConfigService,
    DynamoDBProvider,
    QdrantProvider,
    AnthropicService,
    VoyageService,
    ChatSessionService,
    DiscordService,
    EmailService,
    IdentityService,
    SaveUserFactTool,
    CollectContactInfoTool,
    SendEmailTool,
    ListServicesTool,
    LookupKnowledgeBaseTool,
    PreviewCartTool,
    GenerateCheckoutLinkTool,
    ToolRegistryService,
    LeadCaptureAgent,
    ShoppingAssistantAgent,
    AgentRegistryService,
    EmailReplyService,
    OriginAllowlistService,
    KnowledgeBaseEnrichmentService,
    KnowledgeBaseIngestionService,
  ],
})
export class AppModule {}
