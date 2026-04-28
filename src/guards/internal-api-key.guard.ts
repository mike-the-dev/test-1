import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { timingSafeEqual } from "crypto";

import { InternalApiAuthConfigService } from "../services/internal-api-auth-config.service";

const HEADER_NAME = "x-internal-api-key";

// This guard protects all server-to-server endpoints (currently: /knowledge-base/*).
// Apply it at the controller class level with @UseGuards(InternalApiKeyGuard).
// Adding a future server-to-server controller = one decorator. Replacing the secret
// model (per-partner registry, mTLS, etc.) = swap this implementation behind the
// same interface — no caller changes required.
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

    // HTTP headers can be duplicated (array) — take only the first value if so.
    const incoming = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

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
