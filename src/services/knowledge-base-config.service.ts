import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class KnowledgeBaseConfigService {
  constructor(private readonly configService: ConfigService) {}

  get redisHost(): string {
    return this.configService.get<string>("redis.host", { infer: true }) ?? "localhost";
  }

  get redisPort(): number {
    return this.configService.get<number>("redis.port", { infer: true }) ?? 6379;
  }
}
