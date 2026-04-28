import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { Request } from "express";

import { InternalApiAuthConfigService } from "../services/internal-api-auth-config.service";

const HEADER_NAME = "x-internal-api-key";

// Convention: every server-to-server controller must apply this guard via
// @UseGuards(InternalApiKeyGuard) at the class level. /chat/web/* controllers
// are explicitly exempt — they have their own iframe-facing auth model.
// Replacing the secret model later (per-partner key registry, mTLS) is a
// swap of this implementation behind the same interface — no caller changes.
//
// Deployment assumption: HTTPS is enforced at the infrastructure layer (load balancer /
// reverse proxy). This guard does not verify TLS — that is an infrastructure concern.
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);

  constructor(private readonly config: InternalApiAuthConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;
    const rawHeader = request.headers[HEADER_NAME];

    const incoming = [rawHeader].flat()[0];

    if (!incoming) {
      this.logger.warn(
        `[event=internal_auth_rejected reason=missing_header path=${path}]`,
      );
      throw new UnauthorizedException();
    }

    if (!this.isValidKey(incoming)) {
      this.logger.warn(
        `[event=internal_auth_rejected reason=invalid_key path=${path}]`,
      );
      throw new UnauthorizedException();
    }

    return true;
  }

  private isValidKey(incoming: string): boolean {
    const configured = this.config.key;

    const incomingBuffer = Buffer.from(incoming, "utf8");
    const configuredBuffer = Buffer.from(configured, "utf8");

    // timingSafeEqual throws when buffer lengths differ — reject early to avoid
    // the exception and to avoid leaking length information via error type.
    if (incomingBuffer.byteLength !== configuredBuffer.byteLength) {
      return false;
    }

    return timingSafeEqual(incomingBuffer, configuredBuffer);
  }
}
