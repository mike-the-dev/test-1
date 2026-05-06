import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class TwilioConfigService {
  constructor(private readonly configService: ConfigService) {}

  get accountSid(): string {
    return this.configService.get<string>("twilio.accountSid", { infer: true }) ?? "";
  }

  get authToken(): string {
    return this.configService.get<string>("twilio.authToken", { infer: true }) ?? "";
  }

  get phoneNumber(): string {
    return this.configService.get<string>("twilio.phoneNumber", { infer: true }) ?? "";
  }

  get replyAccountId(): string {
    return this.configService.get<string>("twilio.replyAccountId", { infer: true }) ?? "";
  }

  get publicWebhookUrl(): string {
    const raw = this.configService.get<string>("twilio.publicWebhookUrl", { infer: true }) ?? "";
    return raw.replace(/\/$/, "");
  }
}
