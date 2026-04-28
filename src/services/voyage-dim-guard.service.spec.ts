import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { VoyageDimGuardService } from "./voyage-dim-guard.service";
import { VoyageService } from "./voyage.service";
import { SentryService } from "./sentry.service";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVoyageService = {
  embedText: jest.fn(),
};

const mockSentryService = {
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("VoyageDimGuardService", () => {
  let service: VoyageDimGuardService;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoyageDimGuardService,
        { provide: VoyageService, useValue: mockVoyageService },
        { provide: SentryService, useValue: mockSentryService },
      ],
    }).compile();

    service = module.get<VoyageDimGuardService>(VoyageDimGuardService);

    loggerErrorSpy = jest.spyOn(Logger.prototype, "error");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Pass case
  // -------------------------------------------------------------------------

  it("resolves void when Voyage returns a 1024-dimension vector", async () => {
    mockVoyageService.embedText.mockResolvedValue(Array(1024).fill(0.1));

    await expect(service.checkDimension()).resolves.toBeUndefined();
    expect(mockSentryService.captureException).not.toHaveBeenCalled();
  });

  it("does NOT call Logger.error on a successful probe", async () => {
    mockVoyageService.embedText.mockResolvedValue(Array(1024).fill(0.1));

    await expect(service.checkDimension()).resolves.toBeUndefined();
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it("does NOT call Sentry on a successful probe", async () => {
    mockVoyageService.embedText.mockResolvedValue(Array(1024).fill(0.1));

    await expect(service.checkDimension()).resolves.toBeUndefined();
    expect(mockSentryService.captureException).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Dimension mismatch case
  // -------------------------------------------------------------------------

  it("rejects when Voyage returns a wrong-dimension vector (768 instead of 1024)", async () => {
    mockVoyageService.embedText.mockResolvedValue(Array(768).fill(0.1));

    await expect(service.checkDimension()).rejects.toThrow();
  });

  it("calls Sentry with category=voyage-dim-guard on dimension mismatch", async () => {
    mockVoyageService.embedText.mockResolvedValue(Array(768).fill(0.1));

    await expect(service.checkDimension()).rejects.toThrow();

    expect(mockSentryService.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ category: "voyage-dim-guard", severity: "fatal" }) }),
    );
  });

  it("logs event=boot_failed reason=voyage_dim_mismatch expected=1024 actual=768 on mismatch", async () => {
    mockVoyageService.embedText.mockResolvedValue(Array(768).fill(0.1));

    await expect(service.checkDimension()).rejects.toThrow();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=voyage_dim_mismatch"),
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected=1024"),
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("actual=768"),
    );
  });

  // -------------------------------------------------------------------------
  // Retry cases — transient failure then success
  // Uses jest.runAllTimersAsync() (Jest 27+) to advance fake timers and
  // interleave microtask resolution in a single awaitable call.
  // -------------------------------------------------------------------------

  it("resolves void when embedText fails once then succeeds (first retry)", async () => {
    mockVoyageService.embedText
      .mockRejectedValueOnce(new Error("Voyage network timeout"))
      .mockResolvedValueOnce(Array(1024).fill(0.1));

    const promise = service.checkDimension();
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves void when embedText fails twice then succeeds (second retry)", async () => {
    mockVoyageService.embedText
      .mockRejectedValueOnce(new Error("Voyage timeout"))
      .mockRejectedValueOnce(new Error("Voyage timeout"))
      .mockResolvedValueOnce(Array(1024).fill(0.1));

    const promise = service.checkDimension();
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Exhaustion case — all 3 attempts fail
  // -------------------------------------------------------------------------

  it("rejects when all 3 attempts fail (Voyage outage)", async () => {
    mockVoyageService.embedText.mockRejectedValue(new Error("Voyage unreachable"));

    const promise = service.checkDimension().catch((e: unknown) => e);
    await jest.runAllTimersAsync();

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
  });

  it("calls Sentry with category=voyage-dim-guard when all 3 attempts fail", async () => {
    mockVoyageService.embedText.mockRejectedValue(new Error("Voyage unreachable"));

    const promise = service.checkDimension().catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    await promise;

    expect(mockSentryService.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.objectContaining({ category: "voyage-dim-guard", severity: "fatal" }) }),
    );
  });

  it("logs event=boot_failed reason=voyage_unreachable when all 3 attempts fail", async () => {
    mockVoyageService.embedText.mockRejectedValue(new Error("Voyage unreachable"));

    const promise = service.checkDimension().catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    await promise;

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=voyage_unreachable"),
    );
  });

  // -------------------------------------------------------------------------
  // Retry delay assertions
  // -------------------------------------------------------------------------

  it("waits 1000ms before the first retry", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    mockVoyageService.embedText
      .mockRejectedValueOnce(new Error("Voyage timeout"))
      .mockResolvedValueOnce(Array(1024).fill(0.1));

    const promise = service.checkDimension();
    await jest.runAllTimersAsync();
    await promise.catch(() => undefined);

    const delayArgs = setTimeoutSpy.mock.calls
      .filter((call) => typeof call[1] === "number")
      .map((call) => call[1]);
    expect(delayArgs).toContain(1000);
  });

  it("waits 2000ms before the second retry", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    mockVoyageService.embedText
      .mockRejectedValueOnce(new Error("Voyage timeout"))
      .mockRejectedValueOnce(new Error("Voyage timeout"))
      .mockResolvedValueOnce(Array(1024).fill(0.1));

    const promise = service.checkDimension();
    await jest.runAllTimersAsync();
    await promise.catch(() => undefined);

    const delayArgs = setTimeoutSpy.mock.calls
      .filter((call) => typeof call[1] === "number")
      .map((call) => call[1]);
    expect(delayArgs).toContain(2000);
  });
});
