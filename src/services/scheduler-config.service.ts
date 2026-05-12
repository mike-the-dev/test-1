import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SchedulerConfigService {
  constructor(private readonly configService: ConfigService) {}

  get backend(): string {
    return this.configService.get<string>("scheduler.backend", { infer: true }) ?? "fake";
  }

  get roleArn(): string {
    return this.configService.get<string>("scheduler.roleArn", { infer: true }) ?? "";
  }

  get apiDestinationArn(): string {
    return this.configService.get<string>("scheduler.apiDestinationArn", { infer: true }) ?? "";
  }
}
