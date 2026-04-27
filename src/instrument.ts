// MUST remain the first import — Sentry requires initialization before any other module loads.
import * as Sentry from "@sentry/nestjs";
import type { ErrorEvent, EventHint } from "@sentry/nestjs";
import { BadRequestException, InternalServerErrorException, Logger } from "@nestjs/common";

const PII_KEYS = new Set([
  "text",
  "message",
  "chunk_text",
  "enrichment",
  "email",
  "phone",
  "firstName",
  "lastName",
]);

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === "object") {
    return scrubObject(value as Record<string, unknown>);
  }
  return value;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(obj)) {
    if (PII_KEYS.has(key)) {
      obj[key] = "[Filtered]";
    } else {
      obj[key] = scrubValue(obj[key]);
    }
  }
  return obj;
}

function scrubEvent(event: ErrorEvent): void {
  if (event.extra) {
    scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.contexts) {
    scrubValue(event.contexts);
  }
  if (event.request?.data) {
    scrubValue(event.request.data as Record<string, unknown>);
  }
  if (event.breadcrumbs) {
    for (const breadcrumb of event.breadcrumbs) {
      if (breadcrumb.data) {
        scrubObject(breadcrumb.data as Record<string, unknown>);
      }
    }
  }
}

export function buildBeforeSend(): (event: ErrorEvent, hint: EventHint) => ErrorEvent | null {
  return (event: ErrorEvent, hint: EventHint): ErrorEvent | null => {
    try {
      const originalException = hint?.originalException;

      // Drop validation-class errors — these are user errors, not bugs.
      if (originalException instanceof BadRequestException) {
        return null;
      }

      // Drop auto-captured InternalServerErrorException from the global filter.
      // The KB services already called captureException with rich tags before re-throwing;
      // the global filter would produce a bare duplicate. Drop the duplicate here.
      if (originalException instanceof InternalServerErrorException) {
        return null;
      }

      // Scrub PII from the event in place.
      scrubEvent(event);

      return event;
    } catch (err) {
      // Fail-CLOSED: if the scrubber throws, drop the event rather than risk sending
      // unscrubbed PII. Log loudly so the missing events are noticed.
      const errorMessage = err instanceof Error ? err.message : String(err);
      Logger.warn(
        `[errorType=SentryBeforeSendError] beforeSend threw — dropping event to protect PII [reason=${errorMessage}]`,
        "SentryInstrument",
      );
      return null;
    }
  };
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? "local",
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    beforeSend: buildBeforeSend(),
  });
}
