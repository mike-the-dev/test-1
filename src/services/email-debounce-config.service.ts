import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class EmailDebounceConfigService {
  constructor(private readonly configService: ConfigService) {}

  get enabled(): boolean {
    return this.configService.get<boolean>("emailDebounce.enabled", { infer: true }) ?? false;
  }

  get windowSeconds(): number {
    return this.configService.get<number>("emailDebounce.windowSeconds", { infer: true }) ?? 90;
  }
}
