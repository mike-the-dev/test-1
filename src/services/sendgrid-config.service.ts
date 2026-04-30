import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SendGridConfigService {
  constructor(private readonly configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>("sendgrid.apiKey", { infer: true }) ?? "";
  }

  get fromEmail(): string {
    return this.configService.get<string>("sendgrid.fromEmail", { infer: true }) ?? "";
  }

  get fromName(): string {
    return this.configService.get<string>("sendgrid.fromName", { infer: true }) ?? "";
  }

  get replyDomain(): string {
    return this.configService.get<string>("sendgrid.replyDomain", { infer: true }) ?? "";
  }

  get replyAccountId(): string {
    return this.configService.get<string>("sendgrid.replyAccountId", { infer: true }) ?? "";
  }
}
