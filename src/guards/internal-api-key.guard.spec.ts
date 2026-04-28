import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { InternalApiKeyGuard } from "./internal-api-key.guard";
import { InternalApiAuthConfigService } from "../services/internal-api-auth-config.service";

// ---------------------------------------------------------------------------
// Mock the crypto module so we can spy on timingSafeEqual.
// The factory must use jest.requireActual to preserve other crypto members.
// ---------------------------------------------------------------------------

jest.mock("crypto", () => {
  const actualCrypto = jest.requireActual<typeof import("crypto")>("crypto");
  return {
    ...actualCrypto,
    timingSafeEqual: jest.fn(actualCrypto.timingSafeEqual),
  };
});

// Retrieve a stable reference to the mocked timingSafeEqual after the mock is set up.
const cryptoMock = jest.requireMock<{ timingSafeEqual: jest.Mock }>("crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIGURED_KEY = "test-internal-api-key-32chars-aaaaa";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildContext(headerValue: string | string[] | undefined, path = "/knowledge-base/documents"): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {
          "x-internal-api-key": headerValue,
        },
        path,
      }),
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("InternalApiKeyGuard", () => {
  let guard: InternalApiKeyGuard;

  beforeEach(async () => {
    // Reset the mock between tests so call counts are isolated.
    cryptoMock.timingSafeEqual.mockClear();
    // Restore actual behavior (the factory already wraps the real function).
    cryptoMock.timingSafeEqual.mockImplementation(
      jest.requireActual<typeof import("crypto")>("crypto").timingSafeEqual,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InternalApiKeyGuard,
        {
          provide: InternalApiAuthConfigService,
          useValue: { key: CONFIGURED_KEY },
        },
      ],
    }).compile();

    guard = module.get<InternalApiKeyGuard>(InternalApiKeyGuard);
  });

  // -------------------------------------------------------------------------
  // Missing header → 401
  // -------------------------------------------------------------------------

  describe("missing header → UnauthorizedException", () => {
    it("throws when x-internal-api-key header is undefined", () => {
      const ctx = buildContext(undefined);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it("throws when x-internal-api-key header is empty string", () => {
      const ctx = buildContext("");
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  // -------------------------------------------------------------------------
  // Wrong length → 401, timingSafeEqual NOT called
  // -------------------------------------------------------------------------

  describe("wrong-length header → UnauthorizedException, no timingSafeEqual call", () => {
    it("throws when header is shorter than the configured secret", () => {
      const ctx = buildContext("too-short");
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it("does NOT call timingSafeEqual when header length does not match secret length", () => {
      const ctx = buildContext("too-short");
      try {
        guard.canActivate(ctx);
      } catch {
        // expected to throw
      }
      expect(cryptoMock.timingSafeEqual).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Same length, wrong content → 401, timingSafeEqual IS called
  // -------------------------------------------------------------------------

  describe("same-length wrong-content header → UnauthorizedException, timingSafeEqual called", () => {
    it("throws when header is same length as configured secret but has different content", () => {
      // Same length as CONFIGURED_KEY (35 chars), different value
      const wrongKey = "xxxx-xxxxxxxxxxxxxxx-xxxxxxxx-xxxxx";
      expect(wrongKey.length).toBe(CONFIGURED_KEY.length);

      const ctx = buildContext(wrongKey);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it("calls timingSafeEqual exactly once when lengths match but content differs", () => {
      const wrongKey = "xxxx-xxxxxxxxxxxxxxx-xxxxxxxx-xxxxx";
      expect(wrongKey.length).toBe(CONFIGURED_KEY.length);

      const ctx = buildContext(wrongKey);
      try {
        guard.canActivate(ctx);
      } catch {
        // expected to throw
      }
      expect(cryptoMock.timingSafeEqual).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Correct header → returns true
  // -------------------------------------------------------------------------

  describe("correct header → returns true", () => {
    it("returns true when header exactly matches the configured secret", () => {
      const ctx = buildContext(CONFIGURED_KEY);
      const result = guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it("calls timingSafeEqual (not string ===) for the comparison when lengths match", () => {
      const ctx = buildContext(CONFIGURED_KEY);
      guard.canActivate(ctx);
      expect(cryptoMock.timingSafeEqual).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Array-valued header → takes the first element
  // -------------------------------------------------------------------------

  describe("array-valued header → uses first element", () => {
    it("returns true when the first element of an array header matches the configured secret", () => {
      const ctx = buildContext([CONFIGURED_KEY, "some-other-value"]);
      const result = guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it("throws when the first element of an array header does not match", () => {
      const ctx = buildContext(["wrong-value", CONFIGURED_KEY]);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  // -------------------------------------------------------------------------
  // Logger.warn is called on rejection, not on success
  // -------------------------------------------------------------------------

  describe("Logger.warn — called on rejection, not on success", () => {
    it("calls Logger.warn on missing-header rejection", () => {
      const warnSpy = jest.spyOn(guard["logger"], "warn").mockImplementation(() => undefined);

      const ctx = buildContext(undefined);
      try {
        guard.canActivate(ctx);
      } catch {
        // expected
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[event=internal_auth_rejected"),
      );
      warnSpy.mockRestore();
    });

    it("calls Logger.warn on invalid-key rejection", () => {
      const warnSpy = jest.spyOn(guard["logger"], "warn").mockImplementation(() => undefined);

      const ctx = buildContext("wrong-value");
      try {
        guard.canActivate(ctx);
      } catch {
        // expected
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[event=internal_auth_rejected"),
      );
      warnSpy.mockRestore();
    });

    it("does NOT call Logger.warn when the correct header is provided", () => {
      const warnSpy = jest.spyOn(guard["logger"], "warn").mockImplementation(() => undefined);

      const ctx = buildContext(CONFIGURED_KEY);
      guard.canActivate(ctx);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Header value never appears in log output
  // -------------------------------------------------------------------------

  describe("header value never logged", () => {
    it("does not include the configured key value or the submitted key value in any Logger.warn call on rejection", () => {
      const warnSpy = jest.spyOn(guard["logger"], "warn").mockImplementation(() => undefined);

      // Use a value that is the same length as the configured key but wrong
      const wrongKey = "xxxx-xxxxxxxxxxxxxxx-xxxxxxxx-xxxxx";
      const ctx = buildContext(wrongKey);
      try {
        guard.canActivate(ctx);
      } catch {
        // expected
      }

      const allWarnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
      for (const logLine of allWarnCalls) {
        expect(logLine).not.toContain(CONFIGURED_KEY);
        expect(logLine).not.toContain(wrongKey);
      }

      warnSpy.mockRestore();
    });
  });
});
