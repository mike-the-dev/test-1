import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import configuration from "./config/configuration";
import { validate } from "./config/env.validation";
import { DatabaseConfigService } from "./services/database-config.service";
import { AnthropicConfigService } from "./services/anthropic-config.service";
import { DiscordConfigService } from "./services/discord-config.service";
import { DynamoDBProvider } from "./providers/dynamodb.provider";
import { AnthropicService } from "./services/anthropic.service";
import { ChatSessionService } from "./services/chat-session.service";
import { IdentityService } from "./services/identity.service";
import { DiscordService } from "./services/discord.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.APP_ENV || "local"}`, ".env"],
      load: [configuration],
      validate,
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    DatabaseConfigService,
    AnthropicConfigService,
    DiscordConfigService,
    DynamoDBProvider,
    AnthropicService,
    ChatSessionService,
    IdentityService,
    DiscordService,
  ],
})
export class AppModule {}
