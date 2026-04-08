import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Client, GatewayIntentBits, Message } from "discord.js";

import { DiscordConfigService } from "./discord-config.service";
import { IdentityService } from "./identity.service";
import { ChatSessionService } from "./chat-session.service";

@Injectable()
export class DiscordService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordService.name);
  private readonly client: Client;

  constructor(
    private readonly discordConfig: DiscordConfigService,
    private readonly identityService: IdentityService,
    private readonly chatSessionService: ChatSessionService,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    this.client.on("messageCreate", async (message: Message) => {
      if (message.author.bot) {
        return;
      }

      const authorId = message.author.id;
      const channelId = message.channelId;

      try {
        this.logger.debug(`Received Discord message [user=${authorId} channel=${channelId}]`);

        const sessionUlid = await this.identityService.lookupOrCreateSession(
          "discord",
          authorId,
        );

        const reply = await this.chatSessionService.handleMessage(sessionUlid, message.content);

        await message.reply(reply);

        this.logger.log(`Replied to Discord [user=${authorId} channel=${channelId}]`);
      } catch (error) {
        this.logger.error(`Failed to handle Discord message [user=${authorId} channel=${channelId}]`, error);
        await message.reply("Sorry, something went wrong. Please try again.").catch(() => {});
      }
    });

    const botToken = this.discordConfig.botToken;

    if (!botToken) {
      this.logger.warn("DISCORD_BOT_TOKEN not set — Discord client not started");
      return;
    }

    this.client.once("clientReady", () => {
      this.logger.log(`Discord client logged in [tag=${this.client.user?.tag}]`);
    });

    this.client.once("error", (error) => {
      this.logger.error("Discord client error", error);
    });

    this.logger.log("Discord client logging in");

    try {
      await this.client.login(botToken);
    } catch (error) {
      this.logger.error("Discord client login failed", error);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log("Discord client disconnecting");
    this.client.destroy();
  }
}
