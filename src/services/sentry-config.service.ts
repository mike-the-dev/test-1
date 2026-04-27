import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SentryConfigService {
  constructor(private readonly configService: ConfigService) {}

  get dsn(): string | undefined {
    return this.configService.get<string>("sentry.dsn", {
      infer: true,
    });
  }

  get environment(): string {
    return this.configService.get<string>("sentry.environment", {
      infer: true,
    }) ?? "local";
  }

  get release(): string | undefined {
    return this.configService.get<string>("sentry.release", {
      infer: true,
    });
  }

  get tracesSampleRate(): number {
    return this.configService.get<number>("sentry.tracesSampleRate", {
      infer: true,
    }) ?? 0;
  }
}
