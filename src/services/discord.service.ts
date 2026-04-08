import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Client, GatewayIntentBits, Message } from "discord.js";

import { DiscordConfigService } from "./discord-config.service";
import { IdentityService } from "./identity.service";
import { ChatSessionService } from "./chat-session.service";

@Injectable()
export class DiscordService implements OnModuleInit, OnModuleDestroy {
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

      try {
        const sessionUlid = await this.identityService.lookupOrCreateSession(
          "discord",
          message.author.id,
        );

        const reply = await this.chatSessionService.handleMessage(sessionUlid, message.content);

        await message.reply(reply);
      } catch (error) {
        console.error("Error handling Discord message:", error);
        await message.reply("Sorry, something went wrong. Please try again.").catch(() => {});
      }
    });

    const botToken = this.discordConfig.botToken;

    if (botToken) {
      await this.client.login(botToken);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.destroy();
  }
}
