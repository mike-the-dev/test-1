import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class DatabaseConfigService {
  constructor(private readonly configService: ConfigService) {}

  get region(): string {
    return this.configService.getOrThrow<string>("database.region", {
      infer: true,
    });
  }

  get endpoint(): string | undefined {
    return this.configService.get<string>("database.endpoint", {
      infer: true,
    });
  }

  get conversationsTable(): string {
    return this.configService.getOrThrow<string>(
      "database.conversationsTable",
      { infer: true },
    );
  }
}
