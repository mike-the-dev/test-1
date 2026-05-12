import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class InternalFlushConfigService {
  constructor(private readonly configService: ConfigService) {}

  get secret(): string {
    return this.configService.getOrThrow<string>("internalFlush.secret");
  }

  get url(): string {
    return this.configService.get<string>("internalFlush.url", { infer: true }) ?? "";
  }
}
