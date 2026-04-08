import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class AnthropicConfigService {
  constructor(private readonly configService: ConfigService) {}

  get apiKey(): string | undefined {
    return this.configService.get<string>("anthropic.apiKey", {
      infer: true,
    });
  }

  get model(): string {
    return this.configService.getOrThrow<string>("anthropic.model", {
      infer: true,
    });
  }
}
