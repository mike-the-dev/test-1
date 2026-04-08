import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class DiscordConfigService {
  constructor(private readonly configService: ConfigService) {}

  get botToken(): string | undefined {
    return this.configService.get<string>("discord.botToken", {
      infer: true,
    });
  }

  get guildId(): string | undefined {
    return this.configService.get<string>("discord.guildId", {
      infer: true,
    });
  }
}
