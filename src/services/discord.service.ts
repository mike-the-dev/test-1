import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Client, GatewayIntentBits, Message, Partials } from "discord.js";

import { RawGatewayPacket } from "../types/Discord";

import { DiscordConfigService } from "./discord-config.service";
import { IdentityService } from "./identity.service";
import { ChatSessionService } from "./chat-session.service";

const DISCORD_DEFAULT_AGENT_NAME = "lead_capture";

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
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });
  }

  async onModuleInit(): Promise<void> {
    // discord.js v14.26.2 silently drops DM messageCreate events even with
    // Partials.Channel/Message/User enabled. We dispatch DMs directly from the
    // raw gateway packet as a workaround. Guild messages still flow through the
    // normal messageCreate handler below.
    this.client.on("raw", async (packet: RawGatewayPacket) => {
      if (packet.t !== "MESSAGE_CREATE") {
        return;
      }
      if (!packet.d || packet.d.guild_id) {
        return;
      }
      if (packet.d.author?.bot) {
        return;
      }

      const authorId = packet.d.author?.id;
      const channelId = packet.d.channel_id;
      const content = packet.d.content ?? "";

      if (!authorId || !channelId) {
        return;
      }

      try {
        this.logger.debug(`Received DM [user=${authorId} channel=${channelId}]`);

        const sessionUlid = await this.identityService.lookupOrCreateSession(
          "discord",
          authorId,
          DISCORD_DEFAULT_AGENT_NAME,
        );

        const reply = await this.chatSessionService.handleMessage(sessionUlid, content);

        const user = await this.client.users.fetch(authorId);
        await user.send(reply);

        this.logger.log(`Replied to DM [user=${authorId}]`);
      } catch (error) {
        this.logger.error(`Failed to handle DM [user=${authorId}]`, error);
      }
    });

    this.client.on("messageCreate", async (message: Message) => {
      // DMs are handled by the raw packet handler above. Once discord.js caches
      // the DM channel, messageCreate will also fire for it — skip here to avoid
      // double-processing.
      if (!message.guildId) {
        return;
      }

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
          DISCORD_DEFAULT_AGENT_NAME,
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
