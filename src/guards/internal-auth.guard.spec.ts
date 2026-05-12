import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { InternalAuthGuard } from "./internal-auth.guard";
import { InternalFlushConfigService } from "../services/internal-flush-config.service";

// ---------------------------------------------------------------------------
// Mock crypto so we can spy on timingSafeEqual while preserving actual behavior.
// ---------------------------------------------------------------------------

jest.mock("crypto", () => {
  const actualCrypto = jest.requireActual<typeof import("crypto")>("crypto");
  return {
    ...actualCrypto,
    timingSafeEqual: jest.fn(actualCrypto.timingSafeEqual),
  };
});

const cryptoMock = jest.requireMock<{ timingSafeEqual: jest.Mock }>("crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIGURED_SECRET = "test-flush-secret-32chars-aaaaaa";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildContext(headerValue: string | string[] | undefined, path = "/internal/email-flush/01SESS00000000000000000000"): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {
          "x-internal-auth": headerValue,
        },
        path,
      }),
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InternalAuthGuard", () => {
  let guard: InternalAuthGuard;

  beforeEach(async () => {
    cryptoMock.timingSafeEqual.mockClear();
    cryptoMock.timingSafeEqual.mockImplementation(
      jest.requireActual<typeof import("crypto")>("crypto").timingSafeEqual,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InternalAuthGuard,
        {
          provide: InternalFlushConfigService,
          useValue: { secret: CONFIGURED_SECRET },
        },
      ],
    }).compile();

    guard = module.get<InternalAuthGuard>(InternalAuthGuard);
  });

  // ---------------------------------------------------------------------------
  // Missing header → 401
  // ---------------------------------------------------------------------------

  describe("missing header → UnauthorizedException", () => {
    it("throws when x-internal-auth header is undefined", () => {
      const ctx = buildContext(undefined);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it("throws when x-internal-auth header is empty string", () => {
      const ctx = buildContext("");
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  // ---------------------------------------------------------------------------
  // Wrong-length header → 401, timingSafeEqual NOT called
  // ---------------------------------------------------------------------------

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

    it("throws when header is longer than the configured secret", () => {
      const ctx = buildContext(CONFIGURED_SECRET + "extra-chars");
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  // ---------------------------------------------------------------------------
  // Same-length wrong-content header → 401, timingSafeEqual IS called
  // ---------------------------------------------------------------------------

  describe("same-length wrong-content header → UnauthorizedException, timingSafeEqual called", () => {
    it("throws when header is same length as secret but has different content", () => {
      // Must be exactly CONFIGURED_SECRET.length characters
      const wrongSecret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      expect(wrongSecret.length).toBe(CONFIGURED_SECRET.length);

      const ctx = buildContext(wrongSecret);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it("calls timingSafeEqual exactly once when lengths match but content differs", () => {
      const wrongSecret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      expect(wrongSecret.length).toBe(CONFIGURED_SECRET.length);

      const ctx = buildContext(wrongSecret);
      try {
        guard.canActivate(ctx);
      } catch {
        // expected to throw
      }
      expect(cryptoMock.timingSafeEqual).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Correct header → returns true
  // ---------------------------------------------------------------------------

  describe("correct header → returns true", () => {
    it("returns true when header exactly matches the configured secret", () => {
      const ctx = buildContext(CONFIGURED_SECRET);
      const result = guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it("uses timingSafeEqual (not string ===) for the comparison when lengths match", () => {
      const ctx = buildContext(CONFIGURED_SECRET);
      guard.canActivate(ctx);
      expect(cryptoMock.timingSafeEqual).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Array-valued header → uses first element
  // ---------------------------------------------------------------------------

  describe("array-valued header → uses first element", () => {
    it("returns true when the first element of an array header matches the configured secret", () => {
      const ctx = buildContext([CONFIGURED_SECRET, "other-value"]);
      const result = guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it("throws when the first element of an array header does not match", () => {
      const ctx = buildContext(["wrong-value", CONFIGURED_SECRET]);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  // ---------------------------------------------------------------------------
  // Logger.warn called on rejection, NOT on success
  // ---------------------------------------------------------------------------

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

    it("calls Logger.warn on wrong-secret rejection", () => {
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

      const ctx = buildContext(CONFIGURED_SECRET);
      guard.canActivate(ctx);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Header value never appears in log output
  // ---------------------------------------------------------------------------

  describe("header value never logged", () => {
    it("does not include the secret or submitted value in any Logger.warn call on rejection", () => {
      const warnSpy = jest.spyOn(guard["logger"], "warn").mockImplementation(() => undefined);

      const wrongSecret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      expect(wrongSecret.length).toBe(CONFIGURED_SECRET.length);

      const ctx = buildContext(wrongSecret);
      try {
        guard.canActivate(ctx);
      } catch {
        // expected
      }

      const allWarnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
      for (const logLine of allWarnMessages) {
        expect(logLine).not.toContain(CONFIGURED_SECRET);
        expect(logLine).not.toContain(wrongSecret);
      }

      warnSpy.mockRestore();
    });
  });
});
