import { Test, TestingModule } from "@nestjs/testing";

import { SlackAlertService } from "./slack-alert.service";
import { SlackAlertConfigService } from "./slack-alert-config.service";
import { SentryService } from "./sentry.service";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/testtoken";
const ACCOUNT_ID = "01ACCOUNTULID00000000000000";
const SESSION_ULID = "01TESTSESSION0000000000000";

function makeSlackAlertConfigService(webhookUrl: string | undefined): Partial<SlackAlertConfigService> {
  return { webhookUrl };
}

const mockSentryService = {
  captureException: jest.fn(),
};

async function buildModule(webhookUrl: string | undefined): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      SlackAlertService,
      {
        provide: SlackAlertConfigService,
        useValue: makeSlackAlertConfigService(webhookUrl),
      },
      {
        provide: SentryService,
        useValue: mockSentryService,
      },
    ],
  }).compile();
}

describe("SlackAlertService", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue("ok"),
    } as unknown as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("no-op when SLACK_WEBHOOK_URL is unset", () => {
    let service: SlackAlertService;

    beforeEach(async () => {
      const module = await buildModule(undefined);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    it("notifyConversationStarted does not call fetch when webhookUrl is undefined", async () => {
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("notifyCartCreated does not call fetch when webhookUrl is undefined", async () => {
      await service.notifyCartCreated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, cartTotalCents: 5000, itemCount: 2 });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("notifyCheckoutLinkGenerated does not call fetch when webhookUrl is undefined", async () => {
      await service.notifyCheckoutLinkGenerated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, checkoutUrl: "https://example.com/checkout" });

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("conversation started — successful POST", () => {
    let service: SlackAlertService;

    beforeEach(async () => {
      const module = await buildModule(WEBHOOK_URL);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    it("calls fetch with POST and application/json content-type", async () => {
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1];
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
    });

    it("body contains text fallback and blocks with header '🟢 New conversation started'", async () => {
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      expect(body.text).toBe("🟢 New conversation started");
      const headerBlock = body.blocks[0];
      expect(headerBlock.type).toBe("header");
      expect(headerBlock.text.text).toBe("🟢 New conversation started");
    });

    it("body blocks contain accountId and sessionUlid", async () => {
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const bodyStr = JSON.stringify(body.blocks);
      expect(bodyStr).toContain(ACCOUNT_ID);
      expect(bodyStr).toContain(SESSION_ULID);
    });

    it("webhook URL does not appear in any logged string (logger spy)", async () => {
      const logSpy = jest.spyOn(require("@nestjs/common").Logger.prototype, "error").mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(require("@nestjs/common").Logger.prototype, "warn").mockImplementation(() => undefined);

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: jest.fn().mockResolvedValue("too_many_requests"),
      } as unknown as Response);

      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() });

      const allLogMessages = [
        ...logSpy.mock.calls.map((c) => String(c[0])),
        ...warnSpy.mock.calls.map((c) => String(c[0])),
      ];

      for (const msg of allLogMessages) {
        expect(msg).not.toContain(WEBHOOK_URL);
        expect(msg).not.toContain("hooks.slack.com");
      }

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("resolves without error when fetch returns 200 ok", async () => {
      await expect(
        service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() }),
      ).resolves.toBeUndefined();
    });
  });

  describe("cart created — successful POST", () => {
    let service: SlackAlertService;

    beforeEach(async () => {
      const module = await buildModule(WEBHOOK_URL);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    it("body contains '🛒 Cart created by AI agent'", async () => {
      await service.notifyCartCreated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, cartTotalCents: 4999, itemCount: 3 });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      expect(body.text).toBe("🛒 Cart created by AI agent");
    });

    it("body blocks contain itemCount and formatted cart total", async () => {
      await service.notifyCartCreated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, cartTotalCents: 4999, itemCount: 3 });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const bodyStr = JSON.stringify(body.blocks);
      expect(bodyStr).toContain("3");
      expect(bodyStr).toContain("$49.99");
    });
  });

  describe("checkout link generated — successful POST", () => {
    let service: SlackAlertService;
    const CHECKOUT_URL = "https://example.com/checkout?cartId=abc";

    beforeEach(async () => {
      const module = await buildModule(WEBHOOK_URL);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    it("body contains '🔗 Checkout link generated'", async () => {
      await service.notifyCheckoutLinkGenerated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, checkoutUrl: CHECKOUT_URL });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      expect(body.text).toBe("🔗 Checkout link generated");
    });

    it("body blocks contain checkoutUrl as an mrkdwn link", async () => {
      await service.notifyCheckoutLinkGenerated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, checkoutUrl: CHECKOUT_URL });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const bodyStr = JSON.stringify(body.blocks);
      expect(bodyStr).toContain(CHECKOUT_URL);
      expect(bodyStr).toContain("Open checkout");
    });

    it("checkoutUrl appears in blocks but not in any error log line", async () => {
      const logSpy = jest.spyOn(require("@nestjs/common").Logger.prototype, "error").mockImplementation(() => undefined);

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue("error"),
      } as unknown as Response);

      await service.notifyCheckoutLinkGenerated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, checkoutUrl: CHECKOUT_URL });

      for (const call of logSpy.mock.calls) {
        expect(String(call[0])).not.toContain(CHECKOUT_URL);
      }

      logSpy.mockRestore();
    });
  });

  describe("HTTP failure → Sentry capture", () => {
    let service: SlackAlertService;

    beforeEach(async () => {
      const module = await buildModule(WEBHOOK_URL);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    it("non-2xx response → sentryService.captureException called with conversation_started tags", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: jest.fn().mockResolvedValue("too_many_requests"),
      } as unknown as Response);

      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() });

      expect(mockSentryService.captureException).toHaveBeenCalledTimes(1);
      const context = mockSentryService.captureException.mock.calls[0][1];
      expect(context.tags.category).toBe("slack");
      expect(context.tags.alert_type).toBe("conversation_started");
    });

    it("network error (TypeError) → sentryService.captureException called with cart_created tags", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await service.notifyCartCreated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, cartTotalCents: 1000, itemCount: 1 });

      expect(mockSentryService.captureException).toHaveBeenCalledTimes(1);
      const context = mockSentryService.captureException.mock.calls[0][1];
      expect(context.tags.category).toBe("slack");
      expect(context.tags.alert_type).toBe("cart_created");
    });

    it("error is NOT re-thrown — promise resolves without rejection", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("network down"));

      await expect(
        service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() }),
      ).resolves.toBeUndefined();
    });

    it("error log contains category=slack and alertType but NOT the webhook URL", async () => {
      const errorSpy = jest.spyOn(require("@nestjs/common").Logger.prototype, "error").mockImplementation(() => undefined);

      fetchSpy.mockRejectedValueOnce(new TypeError("network error"));

      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, startedAt: new Date() });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logMsg = String(errorSpy.mock.calls[0][0]);
      expect(logMsg).toContain("category=slack");
      expect(logMsg).toContain("alertType=conversation_started");
      expect(logMsg).not.toContain(WEBHOOK_URL);
      expect(logMsg).not.toContain("hooks.slack.com");

      errorSpy.mockRestore();
    });

    it("AbortError from timeout → captureException called with checkout_link tags, resolves without re-throw", async () => {
      const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      fetchSpy.mockRejectedValueOnce(abortError);

      await expect(
        service.notifyCheckoutLinkGenerated({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID, checkoutUrl: "https://example.com/c" }),
      ).resolves.toBeUndefined();

      expect(mockSentryService.captureException).toHaveBeenCalledTimes(1);
      const context = mockSentryService.captureException.mock.calls[0][1];
      expect(context.tags.alert_type).toBe("checkout_link");
    });
  });
});
