import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SlackAlertConfigService {
  constructor(private readonly configService: ConfigService) {}

  get webhookUrl(): string | undefined {
    return this.configService.get<string>("slack.webhookUrl", { infer: true });
  }
}
