import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { Request } from "express";

import { InternalFlushConfigService } from "../services/internal-flush-config.service";

const HEADER_NAME = "x-internal-auth";

@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  constructor(private readonly config: InternalFlushConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;
    const rawHeader = request.headers[HEADER_NAME];

    const incoming = [rawHeader].flat()[0];

    if (!incoming) {
      this.logger.warn(`[event=internal_auth_rejected reason=missing_header path=${path}]`);
      throw new UnauthorizedException();
    }

    if (!this.isValidSecret(incoming)) {
      this.logger.warn(`[event=internal_auth_rejected reason=invalid_secret path=${path}]`);
      throw new UnauthorizedException();
    }

    return true;
  }

  private isValidSecret(incoming: string): boolean {
    const configured = this.config.secret;

    const incomingBuffer = Buffer.from(incoming, "utf8");
    const configuredBuffer = Buffer.from(configured, "utf8");

    if (incomingBuffer.byteLength !== configuredBuffer.byteLength) {
      return false;
    }

    return timingSafeEqual(incomingBuffer, configuredBuffer);
  }
}
