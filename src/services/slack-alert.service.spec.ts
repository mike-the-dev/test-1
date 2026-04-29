import { Test, TestingModule } from "@nestjs/testing";

import { SlackAlertService } from "./slack-alert.service";
import { SlackAlertConfigService } from "./slack-alert-config.service";
import { SentryService } from "./sentry.service";
import { CartItemAlertEntry } from "../types/Slack";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/testtoken";
const ACCOUNT_ID = "01ACCOUNTULID00000000000000";
const SESSION_ULID = "01TESTSESSION0000000000000";
const CART_ID = "01CARTULID0000000000000000";

const SAMPLE_ITEMS: CartItemAlertEntry[] = [
  { name: "Dog Walking", quantity: 2, subtotalCents: 8000 },
  { name: "Bath & Groom", quantity: 1, subtotalCents: 6000 },
];

function makeSlackAlertConfigService(webhookUrl: string | undefined): Partial<SlackAlertConfigService> {
  return { webhookUrl };
}

const mockSentryService = {
  captureException: jest.fn(),
};

function getBulletItemsBlockText(body: Record<string, unknown>): string {
  const blocks = body.blocks as Array<Record<string, unknown>>;
  const itemsBlock = blocks.find(
    (block) =>
      block.type === "section" &&
      typeof (block.text as Record<string, unknown> | undefined)?.text === "string" &&
      ((block.text as Record<string, unknown>).text as string).startsWith("•"),
  );
  return (itemsBlock?.text as Record<string, unknown> | undefined)?.text as string ?? "";
}

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
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("notifyCartCreated does not call fetch when webhookUrl is undefined", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 5000,
        itemCount: 2,
        items: SAMPLE_ITEMS,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("notifyCheckoutLinkGenerated does not call fetch when webhookUrl is undefined", async () => {
      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 5000,
        items: SAMPLE_ITEMS,
        checkoutUrl: "https://example.com/checkout",
      });

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
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1];
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
    });

    it("body contains text fallback and blocks with header '🟢 New conversation started'", async () => {
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      expect(body.text).toBe("🟢 New conversation started");
      const headerBlock = body.blocks[0];
      expect(headerBlock.type).toBe("header");
      expect(headerBlock.text.text).toBe("🟢 New conversation started");
    });

    it("body blocks contain accountId and sessionUlid", async () => {
      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID });

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

      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID });

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
        service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID }),
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
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 4999,
        itemCount: 3,
        items: SAMPLE_ITEMS,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      expect(body.text).toBe("🛒 Cart created by AI agent");
    });

    it("body blocks contain formatted cart total and guestCartId", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 4999,
        itemCount: 3,
        items: SAMPLE_ITEMS,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const bodyStr = JSON.stringify(body.blocks);
      expect(bodyStr).toContain("$49.99");
      expect(bodyStr).toContain(CART_ID);
    });
  });

  describe("cart created — items rendering", () => {
    let service: SlackAlertService;

    beforeEach(async () => {
      const module = await buildModule(WEBHOOK_URL);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    it("renders item bullet lines with name, quantity, and subtotal", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        itemCount: 3,
        items: SAMPLE_ITEMS,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const text = getBulletItemsBlockText(body);

      expect(text).toContain("• 2× Dog Walking — $80.00");
      // "Bath & Groom" is escaped to "Bath &amp; Groom" in mrkdwn output
      expect(text).toContain("• 1× Bath &amp; Groom — $60.00");
    });

    it("renders correct total line", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        itemCount: 3,
        items: SAMPLE_ITEMS,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const text = getBulletItemsBlockText(body);

      expect(text).toContain("*Total: $140.00*");
    });

    it("renders Cart ID in the fields block", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        itemCount: 3,
        items: SAMPLE_ITEMS,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const bodyStr = JSON.stringify(body.blocks);
      expect(bodyStr).toContain(CART_ID);
      expect(bodyStr).toContain("*Cart ID*");
    });

    it("single item renders without trailing newline artifact", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 8000,
        itemCount: 2,
        items: [{ name: "Dog Walking", quantity: 2, subtotalCents: 8000 }],
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const text = getBulletItemsBlockText(body);

      expect(text).toBe("• 2× Dog Walking — $80.00\n*Total: $80.00*");
    });

    it("empty items array renders only the total line", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 0,
        itemCount: 0,
        items: [],
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const blocks = body.blocks as Array<Record<string, unknown>>;
      const itemsBlock = blocks.find(
        (block) =>
          block.type === "section" &&
          typeof (block.text as Record<string, unknown> | undefined)?.text === "string",
      );
      const text = (itemsBlock?.text as Record<string, unknown> | undefined)?.text as string ?? "";
      expect(text).toBe("*Total: $0.00*");
    });

    it("escapes & < > in item names", async () => {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 5000,
        itemCount: 1,
        items: [{ name: "Bath & Groom <VIP>", quantity: 1, subtotalCents: 5000 }],
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const text = getBulletItemsBlockText(body);

      expect(text).toContain("Bath &amp; Groom &lt;VIP&gt;");
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
      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        items: SAMPLE_ITEMS,
        checkoutUrl: CHECKOUT_URL,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      expect(body.text).toBe("🔗 Checkout link generated");
    });

    it("body blocks contain checkoutUrl as an mrkdwn link", async () => {
      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        items: SAMPLE_ITEMS,
        checkoutUrl: CHECKOUT_URL,
      });

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

      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        items: SAMPLE_ITEMS,
        checkoutUrl: CHECKOUT_URL,
      });

      for (const call of logSpy.mock.calls) {
        expect(String(call[0])).not.toContain(CHECKOUT_URL);
      }

      logSpy.mockRestore();
    });
  });

  describe("checkout link generated — items rendering", () => {
    let service: SlackAlertService;
    const CHECKOUT_URL = "https://example.com/checkout?cartId=abc";

    beforeEach(async () => {
      const module = await buildModule(WEBHOOK_URL);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    it("renders item bullet lines with name, quantity, and subtotal", async () => {
      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        items: SAMPLE_ITEMS,
        checkoutUrl: CHECKOUT_URL,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const text = getBulletItemsBlockText(body);

      expect(text).toContain("• 2× Dog Walking — $80.00");
      // "Bath & Groom" is escaped to "Bath &amp; Groom" in mrkdwn output
      expect(text).toContain("• 1× Bath &amp; Groom — $60.00");
    });

    it("renders correct total line", async () => {
      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        items: SAMPLE_ITEMS,
        checkoutUrl: CHECKOUT_URL,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const text = getBulletItemsBlockText(body);

      expect(text).toContain("*Total: $140.00*");
    });

    it("renders Cart ID and IDs in the IDs block", async () => {
      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        items: SAMPLE_ITEMS,
        checkoutUrl: CHECKOUT_URL,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const bodyStr = JSON.stringify(body.blocks);
      expect(bodyStr).toContain(CART_ID);
      expect(bodyStr).toContain(ACCOUNT_ID);
      expect(bodyStr).toContain(SESSION_ULID);
    });

    it("checkout URL renders as mrkdwn link in its own section block", async () => {
      await service.notifyCheckoutLinkGenerated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 14000,
        items: SAMPLE_ITEMS,
        checkoutUrl: CHECKOUT_URL,
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const blocks = body.blocks as Array<Record<string, unknown>>;
      const checkoutBlock = blocks.find(
        (block) =>
          block.type === "section" &&
          typeof (block.text as Record<string, unknown> | undefined)?.text === "string" &&
          ((block.text as Record<string, unknown>).text as string).includes("Open checkout"),
      );
      expect(checkoutBlock).toBeDefined();
      const text = (checkoutBlock?.text as Record<string, unknown>).text as string;
      expect(text).toContain(CHECKOUT_URL);
      expect(text).toContain("Open checkout");
    });
  });

  describe("formatCentsAsUsd — currency formatting (via block output)", () => {
    let service: SlackAlertService;

    beforeEach(async () => {
      const module = await buildModule(WEBHOOK_URL);
      service = module.get<SlackAlertService>(SlackAlertService);
    });

    async function getTotalLine(cartTotalCents: number): Promise<string> {
      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents,
        itemCount: 1,
        items: [{ name: "Item", quantity: 1, subtotalCents: cartTotalCents }],
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
      const blocks = body.blocks as Array<Record<string, unknown>>;
      const itemsBlock = blocks.find(
        (block) =>
          block.type === "section" &&
          typeof (block.text as Record<string, unknown> | undefined)?.text === "string" &&
          ((block.text as Record<string, unknown>).text as string).includes("Total"),
      );
      return (itemsBlock?.text as Record<string, unknown> | undefined)?.text as string ?? "";
    }

    it("0 cents renders as $0.00", async () => {
      const text = await getTotalLine(0);
      expect(text).toContain("*Total: $0.00*");
    });

    it("100 cents renders as $1.00", async () => {
      const text = await getTotalLine(100);
      expect(text).toContain("*Total: $1.00*");
    });

    it("1234 cents renders as $12.34", async () => {
      const text = await getTotalLine(1234);
      expect(text).toContain("*Total: $12.34*");
    });

    it("100000 cents renders as $1000.00", async () => {
      const text = await getTotalLine(100000);
      expect(text).toContain("*Total: $1000.00*");
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

      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID });

      expect(mockSentryService.captureException).toHaveBeenCalledTimes(1);
      const context = mockSentryService.captureException.mock.calls[0][1];
      expect(context.tags.category).toBe("slack");
      expect(context.tags.alert_type).toBe("conversation_started");
    });

    it("network error (TypeError) → sentryService.captureException called with cart_created tags", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await service.notifyCartCreated({
        accountId: ACCOUNT_ID,
        sessionUlid: SESSION_ULID,
        guestCartId: CART_ID,
        cartTotalCents: 1000,
        itemCount: 1,
        items: [{ name: "Item", quantity: 1, subtotalCents: 1000 }],
      });

      expect(mockSentryService.captureException).toHaveBeenCalledTimes(1);
      const context = mockSentryService.captureException.mock.calls[0][1];
      expect(context.tags.category).toBe("slack");
      expect(context.tags.alert_type).toBe("cart_created");
    });

    it("error is NOT re-thrown — promise resolves without rejection", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("network down"));

      await expect(
        service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID }),
      ).resolves.toBeUndefined();
    });

    it("error log contains category=slack and alertType but NOT the webhook URL", async () => {
      const errorSpy = jest.spyOn(require("@nestjs/common").Logger.prototype, "error").mockImplementation(() => undefined);

      fetchSpy.mockRejectedValueOnce(new TypeError("network error"));

      await service.notifyConversationStarted({ accountId: ACCOUNT_ID, sessionUlid: SESSION_ULID });

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
        service.notifyCheckoutLinkGenerated({
          accountId: ACCOUNT_ID,
          sessionUlid: SESSION_ULID,
          guestCartId: CART_ID,
          cartTotalCents: 0,
          items: [],
          checkoutUrl: "https://example.com/c",
        }),
      ).resolves.toBeUndefined();

      expect(mockSentryService.captureException).toHaveBeenCalledTimes(1);
      const context = mockSentryService.captureException.mock.calls[0][1];
      expect(context.tags.alert_type).toBe("checkout_link");
    });
  });
});
