import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, DiscoveryModule } from "@nestjs/core";
import { BullModule } from "@nestjs/bullmq";
import { SentryModule, SentryGlobalFilter } from "@sentry/nestjs/setup";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import configuration from "./config/configuration";
import { validate } from "./config/env.validation";
import { DatabaseConfigService } from "./services/database-config.service";
import { QdrantConfigService } from "./services/qdrant-config.service";
import { AnthropicConfigService } from "./services/anthropic-config.service";
import { VoyageConfigService } from "./services/voyage-config.service";
import { VoyageService } from "./services/voyage.service";
import { SendGridConfigService } from "./services/sendgrid-config.service";
import { DynamoDBProvider } from "./providers/dynamodb.provider";
import { QdrantProvider } from "./providers/qdrant.provider";
import { AnthropicService } from "./services/anthropic.service";
import { ChatSessionService } from "./services/chat-session.service";
import { EmailService } from "./services/email.service";
import { SessionService } from "./services/session.service";
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
import { RequestVerificationCodeTool } from "./tools/request-verification-code.tool";
import { VerifyCodeTool } from "./tools/verify-code.tool";
import { CheckActiveCartTool } from "./tools/check-active-cart.tool";
import { CustomerService } from "./services/customer.service";
import { EmailReplyService } from "./services/email-reply.service";
import { TwilioConfigService } from "./services/twilio-config.service";
import { SmsService } from "./services/sms.service";
import { SmsReplyService } from "./services/sms-reply.service";
import { TwilioWebhookController } from "./controllers/twilio-webhook.controller";
import { KB_INGESTION_QUEUE_NAME } from "./utils/knowledge-base/constants";
import { KnowledgeBaseController } from "./controllers/knowledge-base.controller";
import { SendgridWebhookController } from "./controllers/sendgrid-webhook.controller";
import { WebChatController } from "./controllers/web-chat.controller";
import { KnowledgeBaseEnrichmentService } from "./services/knowledge-base-enrichment.service";
import { KnowledgeBaseIngestionService } from "./services/knowledge-base-ingestion.service";
import { KnowledgeBaseConfigModule } from "./services/knowledge-base-config.module";
import { KnowledgeBaseConfigService } from "./services/knowledge-base-config.service";
import { KnowledgeBaseIngestionProcessor } from "./processors/knowledge-base-ingestion.processor";
import { OriginAllowlistService } from "./services/origin-allowlist.service";
import { ChannelAddressService } from "./services/channel-address.service";
import { SentryConfigService } from "./services/sentry-config.service";
import { SentryService } from "./services/sentry.service";
import { SlackAlertConfigService } from "./services/slack-alert-config.service";
import { SlackAlertService } from "./services/slack-alert.service";
import { InternalApiAuthConfigService } from "./services/internal-api-auth-config.service";
import { InternalApiKeyGuard } from "./guards/internal-api-key.guard";
import { VoyageDimGuardService } from "./services/voyage-dim-guard.service";
import { EmailDebounceConfigService } from "./services/email-debounce-config.service";
import { InternalFlushConfigService } from "./services/internal-flush-config.service";
import { SchedulerConfigService } from "./services/scheduler-config.service";
import { SchedulerService, SCHEDULER_SERVICE } from "./services/scheduler.service";
import { SchedulerFakeService } from "./services/scheduler-fake.service";
import { ReplyOrchestratorService } from "./services/reply-orchestrator.service";
import { InternalAuthGuard } from "./guards/internal-auth.guard";
import { InternalEmailFlushController } from "./controllers/internal-email-flush.controller";

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.APP_ENV || "local"}`, ".env"],
      load: [configuration],
      validate,
    }),
    DiscoveryModule,
    KnowledgeBaseConfigModule,
    BullModule.forRootAsync({
      imports: [KnowledgeBaseConfigModule],
      inject: [KnowledgeBaseConfigService],
      useFactory: (knowledgeBaseConfigService: KnowledgeBaseConfigService) => {
        return {
          connection: {
            host: knowledgeBaseConfigService.redisHost,
            port: knowledgeBaseConfigService.redisPort,
          },
        };
      },
    }),
    BullModule.registerQueue({
      name: KB_INGESTION_QUEUE_NAME,
    }),
  ],
  controllers: [AppController, SendgridWebhookController, TwilioWebhookController, WebChatController, KnowledgeBaseController, InternalEmailFlushController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
    SentryConfigService,
    SentryService,
    SlackAlertConfigService,
    SlackAlertService,
    InternalApiAuthConfigService,
    InternalApiKeyGuard,
    AppService,
    DatabaseConfigService,
    QdrantConfigService,
    AnthropicConfigService,
    VoyageConfigService,
    SendGridConfigService,
    DynamoDBProvider,
    QdrantProvider,
    AnthropicService,
    VoyageService,
    VoyageDimGuardService,
    ChatSessionService,
    EmailService,
    SessionService,
    SaveUserFactTool,
    CollectContactInfoTool,
    SendEmailTool,
    ListServicesTool,
    LookupKnowledgeBaseTool,
    PreviewCartTool,
    GenerateCheckoutLinkTool,
    RequestVerificationCodeTool,
    VerifyCodeTool,
    CheckActiveCartTool,
    CustomerService,
    ToolRegistryService,
    LeadCaptureAgent,
    ShoppingAssistantAgent,
    AgentRegistryService,
    EmailReplyService,
    TwilioConfigService,
    SmsService,
    SmsReplyService,
    OriginAllowlistService,
    ChannelAddressService,
    KnowledgeBaseEnrichmentService,
    KnowledgeBaseIngestionService,
    KnowledgeBaseIngestionProcessor,
    EmailDebounceConfigService,
    InternalFlushConfigService,
    SchedulerConfigService,
    SchedulerService,
    SchedulerFakeService,
    {
      provide: SCHEDULER_SERVICE,
      inject: [SchedulerConfigService, SchedulerService, SchedulerFakeService],
      useFactory: (
        schedulerConfig: SchedulerConfigService,
        real: SchedulerService,
        fake: SchedulerFakeService,
      ) => {
        return schedulerConfig.backend === "real" ? real : fake;
      },
    },
    ReplyOrchestratorService,
    InternalAuthGuard,
  ],
})
export class AppModule {}
