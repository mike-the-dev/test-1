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
  "x-internal-api-key",
]);

function scrubRecord(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (PII_KEYS.has(key)) {
      record[key] = "[Filtered]";
      continue;
    }

    // Defense in depth: recurse into nested plain object literals so a future
    // contributor passing an extras shape like `{ payload: { message: "..." } }`
    // still gets the inner `message` scrubbed. Plain-object detection via
    // Object.getPrototypeOf avoids walking arrays, Maps, class instances, etc.
    const nested = record[key];
    if (nested !== null && nested !== undefined && Object.getPrototypeOf(nested) === Object.prototype) {
      scrubRecord(nested as unknown as Record<string, unknown>);
    }
  }
}

function scrubContexts(contexts: Record<string, Record<string, unknown> | undefined>): void {
  for (const context of Object.values(contexts)) {
    if (context) {
      scrubRecord(context);
    }
  }
}

function scrubEvent(event: ErrorEvent): void {
  if (event.extra) {
    scrubRecord(event.extra);
  }

  if (event.contexts) {
    scrubContexts(event.contexts);
  }

  if (event.request) {
    // Intentional deviation from the plan: clear request.data entirely rather than
    // recursively scrubbing PII keys. Justification: request.data is `unknown`-typed
    // in the Sentry SDK, so a targeted recursive scrub would require unsafe type
    // assertions on every read. For our medical/healthcare client verticals, the
    // small loss of non-PII diagnostic context is worth the defense-in-depth gain.
    event.request.data = undefined;

    // Redact the internal API key header from any captured event's request context.
    // Never let the shared secret reach Sentry, even if a future capture path
    // accidentally includes full request context.
    if (event.request.headers) {
      if (event.request.headers["x-internal-api-key"]) {
        event.request.headers["x-internal-api-key"] = "[Filtered]";
      }
    }
  }

  if (event.breadcrumbs) {
    for (const breadcrumb of event.breadcrumbs) {
      if (breadcrumb.data) {
        scrubRecord(breadcrumb.data);
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
