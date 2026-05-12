import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SchedulerConfigService {
  constructor(private readonly configService: ConfigService) {}

  get backend(): string {
    return this.configService.get<string>("scheduler.backend", { infer: true }) ?? "fake";
  }

  get region(): string {
    return this.configService.get<string>("scheduler.region", { infer: true }) ?? "us-east-1";
  }

  get roleArn(): string {
    return this.configService.get<string>("scheduler.roleArn", { infer: true }) ?? "";
  }

  get lambdaArn(): string {
    return this.configService.get<string>("scheduler.lambdaArn", { infer: true }) ?? "";
  }
}
