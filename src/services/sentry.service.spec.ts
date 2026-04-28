import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import type { ErrorEvent, EventHint } from "@sentry/nestjs";

import { SentryService } from "./sentry.service";
import { buildBeforeSend } from "../instrument";

// ---------------------------------------------------------------------------
// Mock @sentry/nestjs at the module level.
// IMPORTANT: jest.mock() is hoisted before const/let declarations, so the
// factory must NOT reference variables declared outside. Use jest.fn() inline
// and retrieve them after via jest.requireMock().
// ---------------------------------------------------------------------------

jest.mock("@sentry/nestjs", () => ({
  isInitialized: jest.fn(),
  withScope: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

// Retrieve stable references to the mocked functions after the mock is set up.
const SentryMock = jest.requireMock<{
  isInitialized: jest.Mock;
  withScope: jest.Mock;
  captureException: jest.Mock;
  captureMessage: jest.Mock;
  addBreadcrumb: jest.Mock;
}>("@sentry/nestjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildService(): Promise<SentryService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [SentryService],
  }).compile();
  return module.get<SentryService>(SentryService);
}

// ---------------------------------------------------------------------------
// SentryService — no-op behavior (DSN absent)
// ---------------------------------------------------------------------------

describe("SentryService — no-op when DSN absent (isInitialized returns false)", () => {
  let service: SentryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    SentryMock.isInitialized.mockReturnValue(false);
    service = await buildService();
  });

  it("captureException does not call Sentry.withScope when not initialized", () => {
    service.captureException(new Error("test error"));
    expect(SentryMock.withScope).not.toHaveBeenCalled();
  });

  it("captureMessage does not call Sentry.withScope when not initialized", () => {
    service.captureMessage("test message", "warning");
    expect(SentryMock.withScope).not.toHaveBeenCalled();
  });

  it("addBreadcrumb does not call Sentry.addBreadcrumb when not initialized", () => {
    service.addBreadcrumb("test message", "test-category");
    expect(SentryMock.addBreadcrumb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SentryService — active behavior (DSN present)
// ---------------------------------------------------------------------------

describe("SentryService — active when DSN present (isInitialized returns true)", () => {
  let service: SentryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    SentryMock.isInitialized.mockReturnValue(true);

    // Make withScope actually invoke the callback with a fake scope object
    SentryMock.withScope.mockImplementation((callback: (scope: Record<string, jest.Mock>) => void) => {
      const fakeScope = {
        setTag: jest.fn(),
        setExtras: jest.fn(),
        setLevel: jest.fn(),
      };
      callback(fakeScope);
    });

    service = await buildService();
  });

  it("captureException calls Sentry.withScope and Sentry.captureException with the error", () => {
    const error = new Error("something went wrong");
    service.captureException(error);

    expect(SentryMock.withScope).toHaveBeenCalledTimes(1);
    expect(SentryMock.captureException).toHaveBeenCalledWith(error);
  });

  it("captureException sets tags on the scope when tags are provided", () => {
    let capturedScope: Record<string, jest.Mock> | undefined;
    SentryMock.withScope.mockImplementation((callback: (scope: Record<string, jest.Mock>) => void) => {
      const fakeScope = { setTag: jest.fn(), setExtras: jest.fn(), setLevel: jest.fn() };
      capturedScope = fakeScope;
      callback(fakeScope);
    });

    service.captureException(new Error("err"), { tags: { category: "voyage", account_id: "acct-123" } });

    expect(capturedScope!.setTag).toHaveBeenCalledWith("category", "voyage");
    expect(capturedScope!.setTag).toHaveBeenCalledWith("account_id", "acct-123");
  });

  it("captureException sets extras on the scope when extras are provided", () => {
    let capturedScope: Record<string, jest.Mock> | undefined;
    SentryMock.withScope.mockImplementation((callback: (scope: Record<string, jest.Mock>) => void) => {
      const fakeScope = { setTag: jest.fn(), setExtras: jest.fn(), setLevel: jest.fn() };
      capturedScope = fakeScope;
      callback(fakeScope);
    });

    service.captureException(new Error("err"), { extras: { statusCode: "500" } });

    expect(capturedScope!.setExtras).toHaveBeenCalledWith({ statusCode: "500" });
  });

  it("captureException with no context arg does not throw", () => {
    expect(() => service.captureException(new Error("bare error"))).not.toThrow();
    expect(SentryMock.withScope).toHaveBeenCalledTimes(1);
  });

  it("captureMessage calls Sentry.withScope and Sentry.captureMessage with the message", () => {
    service.captureMessage("enrichment failed", "warning");

    expect(SentryMock.withScope).toHaveBeenCalledTimes(1);
    expect(SentryMock.captureMessage).toHaveBeenCalledWith("enrichment failed");
  });

  it("captureMessage sets level on the scope", () => {
    let capturedScope: Record<string, jest.Mock> | undefined;
    SentryMock.withScope.mockImplementation((callback: (scope: Record<string, jest.Mock>) => void) => {
      const fakeScope = { setTag: jest.fn(), setExtras: jest.fn(), setLevel: jest.fn() };
      capturedScope = fakeScope;
      callback(fakeScope);
    });

    service.captureMessage("msg", "error");

    expect(capturedScope!.setLevel).toHaveBeenCalledWith("error");
  });

  it("addBreadcrumb calls Sentry.addBreadcrumb with message and category", () => {
    service.addBreadcrumb("starting ingestion", "ingestion");

    expect(SentryMock.addBreadcrumb).toHaveBeenCalledWith({
      message: "starting ingestion",
      category: "ingestion",
    });
  });
});

// ---------------------------------------------------------------------------
// SentryService — safety: does not re-throw when SDK throws
// ---------------------------------------------------------------------------

describe("SentryService — does not re-throw when SDK itself throws", () => {
  let service: SentryService;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    SentryMock.isInitialized.mockReturnValue(true);
    SentryMock.withScope.mockImplementation(() => {
      throw new Error("SDK internal error");
    });
    SentryMock.addBreadcrumb.mockImplementation(() => {
      throw new Error("SDK breadcrumb error");
    });

    service = await buildService();
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("captureException does not re-throw when Sentry.withScope throws", () => {
    expect(() => service.captureException(new Error("test"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("captureException call threw"));
  });

  it("captureMessage does not re-throw when Sentry.withScope throws", () => {
    expect(() => service.captureMessage("test message", "warning")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("captureMessage call threw"));
  });

  it("addBreadcrumb does not re-throw when Sentry.addBreadcrumb throws", () => {
    expect(() => service.addBreadcrumb("test", "cat")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("addBreadcrumb call threw"));
  });
});

// ---------------------------------------------------------------------------
// buildBeforeSend — PII scrubbing and filtering
// ---------------------------------------------------------------------------

describe("buildBeforeSend — PII scrubbing and event filtering", () => {
  const beforeSend = buildBeforeSend();

  function makeEvent(extra: Record<string, unknown> = {}): ErrorEvent {
    return { type: undefined, extra };
  }

  function makeHint(originalException: unknown): EventHint {
    return { originalException };
  }

  it("returns null when hint.originalException is a BadRequestException", () => {
    const result = beforeSend(makeEvent(), makeHint(new BadRequestException("bad input")));
    expect(result).toBeNull();
  });

  it("returns null when hint.originalException is an InternalServerErrorException (suppress global-filter duplicate)", () => {
    const result = beforeSend(makeEvent(), makeHint(new InternalServerErrorException("internal")));
    expect(result).toBeNull();
  });

  it("does NOT return null for a generic Error", () => {
    const result = beforeSend(makeEvent(), makeHint(new Error("generic")));
    expect(result).not.toBeNull();
  });

  it("returns the event (mutated) when no filter condition matches", () => {
    const event = makeEvent({ account_id: "acct-001" });
    const result = beforeSend(event, makeHint(new Error("something")));
    expect(result).toBe(event);
  });

  it("scrubs event.extra.message → [Filtered]", () => {
    const event = makeEvent({ message: "user chat message content" });
    beforeSend(event, makeHint(new Error("err")));
    expect(event.extra!.message).toBe("[Filtered]");
  });

  it("scrubs event.extra.text → [Filtered]", () => {
    const event = makeEvent({ text: "document text content" });
    beforeSend(event, makeHint(new Error("err")));
    expect(event.extra!.text).toBe("[Filtered]");
  });

  it("scrubs event.extra.chunk_text → [Filtered]", () => {
    const event = makeEvent({ chunk_text: "chunk content here" });
    beforeSend(event, makeHint(new Error("err")));
    expect(event.extra!.chunk_text).toBe("[Filtered]");
  });

  it("scrubs event.extra.enrichment → [Filtered]", () => {
    const event = makeEvent({ enrichment: "enrichment data" });
    beforeSend(event, makeHint(new Error("err")));
    expect(event.extra!.enrichment).toBe("[Filtered]");
  });

  it("scrubs email, phone, firstName, lastName from extra", () => {
    const event = makeEvent({
      email: "user@example.com",
      phone: "555-1234",
      firstName: "Jane",
      lastName: "Doe",
    });
    beforeSend(event, makeHint(new Error("err")));
    const extra = event.extra!;
    expect(extra.email).toBe("[Filtered]");
    expect(extra.phone).toBe("[Filtered]");
    expect(extra.firstName).toBe("[Filtered]");
    expect(extra.lastName).toBe("[Filtered]");
  });

  it("does NOT scrub account_id, document_id, external_id, chunk_index, errorType, statusCode", () => {
    const event = makeEvent({
      account_id: "acct-001",
      document_id: "doc-001",
      external_id: "ext-001",
      chunk_index: 3,
      errorType: "NetworkError",
      statusCode: "500",
    });
    beforeSend(event, makeHint(new Error("err")));
    const extra = event.extra!;
    expect(extra.account_id).toBe("acct-001");
    expect(extra.document_id).toBe("doc-001");
    expect(extra.external_id).toBe("ext-001");
    expect(extra.chunk_index).toBe(3);
    expect(extra.errorType).toBe("NetworkError");
    expect(extra.statusCode).toBe("500");
  });

  it("scrubs PII keys nested inside event.contexts recursively", () => {
    const event: ErrorEvent = {
      type: undefined,
      contexts: {
        request: {
          email: "secret@example.com",
          account_id: "acct-001",
        },
      },
    };

    beforeSend(event, makeHint(new Error("err")));

    expect(event.contexts!.request!.email).toBe("[Filtered]");
    expect(event.contexts!.request!.account_id).toBe("acct-001");
  });

  it("scrubs x-internal-api-key from event.request.headers → [Filtered]", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        headers: {
          "x-internal-api-key": "some-secret-value-here-that-should-not-appear",
          "content-type": "application/json",
        },
      },
    };

    const result = beforeSend(event, makeHint(new Error("some error")));

    expect(result).not.toBeNull();
    const headers = result!.request!.headers as Record<string, string>;
    expect(headers["x-internal-api-key"]).toBe("[Filtered]");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("returns null and logs a warning when beforeSend logic itself throws", () => {
    // Use a getter that throws to simulate a scrubbing error
    const base: ErrorEvent = { type: undefined };
    const trickEvent = Object.defineProperty(base, "extra", {
      get() {
        throw new Error("Simulated scrub error");
      },
    });

    const warnSpy = jest.spyOn(Logger, "warn").mockImplementation(() => undefined);
    const result = beforeSend(trickEvent, makeHint(new Error("original")));
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("beforeSend threw"),
      "SentryInstrument",
    );
    warnSpy.mockRestore();
  });
});
