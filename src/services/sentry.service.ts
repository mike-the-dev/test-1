import { Injectable, Logger } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";

import { SentryCaptureContext } from "../types/Sentry";

@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);
  private readonly isDsnConfigured: boolean;

  constructor() {
    this.isDsnConfigured = Sentry.isInitialized();
  }

  captureException(error: unknown, context?: SentryCaptureContext): void {
    if (!this.isDsnConfigured) {
      return;
    }

    try {
      Sentry.withScope((scope) => {
        if (context?.tags) {
          for (const [key, value] of Object.entries(context.tags)) {
            scope.setTag(key, value);
          }
        }
        if (context?.extras) {
          scope.setExtras(context.extras);
        }
        Sentry.captureException(error);
      });
    } catch (sdkError) {
      const errorMessage = sdkError instanceof Error ? sdkError.message : String(sdkError);
      this.logger.warn(
        `[errorType=SentrySDKError] captureException call threw — Sentry SDK error [reason=${errorMessage}]`,
      );
    }
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error",
    context?: SentryCaptureContext,
  ): void {
    if (!this.isDsnConfigured) {
      return;
    }

    try {
      Sentry.withScope((scope) => {
        scope.setLevel(level);
        if (context?.tags) {
          for (const [key, value] of Object.entries(context.tags)) {
            scope.setTag(key, value);
          }
        }
        if (context?.extras) {
          scope.setExtras(context.extras);
        }
        Sentry.captureMessage(message);
      });
    } catch (sdkError) {
      const errorMessage = sdkError instanceof Error ? sdkError.message : String(sdkError);
      this.logger.warn(
        `[errorType=SentrySDKError] captureMessage call threw — Sentry SDK error [reason=${errorMessage}]`,
      );
    }
  }

  addBreadcrumb(message: string, category: string): void {
    if (!this.isDsnConfigured) {
      return;
    }

    try {
      Sentry.addBreadcrumb({ message, category });
    } catch (sdkError) {
      const errorMessage = sdkError instanceof Error ? sdkError.message : String(sdkError);
      this.logger.warn(
        `[errorType=SentrySDKError] addBreadcrumb call threw — Sentry SDK error [reason=${errorMessage}]`,
      );
    }
  }
}
