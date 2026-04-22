import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class QdrantConfigService {
  constructor(private readonly configService: ConfigService) {}

  get url(): string {
    return this.configService.getOrThrow<string>("qdrant.url", {
      infer: true,
    });
  }

  get apiKey(): string | undefined {
    return this.configService.get<string>("qdrant.apiKey", {
      infer: true,
    });
  }
}
