import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class InternalApiAuthConfigService {
  constructor(private readonly configService: ConfigService) {}

  get key(): string {
    return this.configService.getOrThrow<string>("internalApiAuth.key", { infer: true });
  }
}
