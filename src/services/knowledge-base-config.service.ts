import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class KnowledgeBaseConfigService {
  constructor(private readonly configService: ConfigService) {}

  get redisHost(): string {
    return this.configService.getOrThrow<string>("redis.host", {
      infer: true,
    });
  }

  get redisPort(): number {
    return this.configService.getOrThrow<number>("redis.port", {
      infer: true,
    });
  }
}
