import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class VoyageConfigService {
  constructor(private readonly configService: ConfigService) {}

  get apiKey(): string | undefined {
    return this.configService.get<string>("voyage.apiKey", {
      infer: true,
    });
  }

  get model(): string {
    return this.configService.getOrThrow<string>("voyage.model", {
      infer: true,
    });
  }
}
