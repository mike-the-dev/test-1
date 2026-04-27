import { BadRequestException, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ChatSessionService } from "../services/chat-session.service";
import { IdentityService } from "../services/identity.service";
import { OriginAllowlistService } from "../services/origin-allowlist.service";
import { SlackAlertService } from "../services/slack-alert.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import {
  createSessionSchema,
  embedAuthorizeSchema,
  onboardingSchema,
  sendMessageSchema,
  sessionUlidParamSchema,
} from "../validation/web-chat.schema";
import { WebChatController } from "./web-chat.controller";

const VALID_GUEST_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_SESSION_ULID = "01BX5ZZKBKACTAV9WEVGEMMVS1";
const VALID_ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const VALID_ACCOUNT_ULID_WITH_PREFIX = `A#${VALID_ACCOUNT_ULID}`;
const AGENT_NAME = "lead_capture";

const mockIdentityService = {
  lookupOrCreateSession: jest.fn(),
  updateOnboarding: jest.fn(),
};

const mockChatSessionService = {
  handleMessage: jest.fn(),
  getHistoryForClient: jest.fn(),
};

const mockAgentRegistry = {
  getByName: jest.fn(),
};

const mockOriginAllowlistService = {
  resolveAccountForOrigin: jest.fn(),
  verifyAccountActive: jest.fn(),
  isOriginAuthorizedForAccount: jest.fn(),
};

const mockSlackAlertService = {
  notifyConversationStarted: jest.fn().mockResolvedValue(undefined),
  notifyCartCreated: jest.fn().mockResolvedValue(undefined),
  notifyCheckoutLinkGenerated: jest.fn().mockResolvedValue(undefined),
};

describe("WebChatController", () => {
  let controller: WebChatController;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockOriginAllowlistService.verifyAccountActive.mockResolvedValue(VALID_ACCOUNT_ULID);
    mockIdentityService.lookupOrCreateSession.mockResolvedValue({
      sessionUlid: VALID_SESSION_ULID,
      onboardingCompletedAt: null,
      kickoffCompletedAt: null,
      budgetCents: null,
      wasCreated: false,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebChatController],
      providers: [
        { provide: IdentityService, useValue: mockIdentityService },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: AgentRegistryService, useValue: mockAgentRegistry },
        { provide: OriginAllowlistService, useValue: mockOriginAllowlistService },
        { provide: SlackAlertService, useValue: mockSlackAlertService },
      ],
    }).compile();

    controller = module.get<WebChatController>(WebChatController);
  });

  describe("POST /sessions — createSession", () => {
    it("throws BadRequestException for unknown agentName without calling IdentityService", async () => {
      mockAgentRegistry.getByName.mockReturnValue(null);

      await expect(
        controller.createSession({
          agentName: "unknown_agent",
          guestUlid: VALID_GUEST_ULID,
          accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockIdentityService.lookupOrCreateSession).not.toHaveBeenCalled();
    });

    it("returns sessionUlid, displayName, and onboarding nulls for a new session", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result).toEqual({
        sessionUlid: VALID_SESSION_ULID,
        displayName: "Lead Capture Assistant",
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        budgetCents: null,
      });
      expect(mockIdentityService.lookupOrCreateSession).toHaveBeenCalledWith(
        "web",
        VALID_GUEST_ULID,
        AGENT_NAME,
        VALID_ACCOUNT_ULID,
      );
    });

    it("echoes onboardingCompletedAt and budgetCents from IdentityService for a returning session", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        kickoffCompletedAt: null,
        budgetCents: 100_000,
        wasCreated: false,
      });

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.onboardingCompletedAt).toBe("2026-04-19T20:00:00.000Z");
      expect(result.budgetCents).toBe(100_000);
    });

    it("echoes kickoffCompletedAt from IdentityService when the session has a kickoff stamp", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        kickoffCompletedAt: "2026-04-20T22:00:00.000Z",
        budgetCents: 100_000,
        wasCreated: false,
      });

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.kickoffCompletedAt).toBe("2026-04-20T22:00:00.000Z");
    });

    it("falls back to agent.name when displayName is not set", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: undefined });

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.displayName).toBe(AGENT_NAME);
    });

    it("strips the A# prefix from body.accountUlid before calling verifyAccountActive", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });

      await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(mockOriginAllowlistService.verifyAccountActive).toHaveBeenCalledWith(VALID_ACCOUNT_ULID);
      expect(mockOriginAllowlistService.verifyAccountActive).not.toHaveBeenCalledWith(VALID_ACCOUNT_ULID_WITH_PREFIX);
    });

    it("throws InternalServerErrorException when verifyAccountActive returns null", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });
      mockOriginAllowlistService.verifyAccountActive.mockResolvedValue(null);

      await expect(
        controller.createSession({
          agentName: AGENT_NAME,
          guestUlid: VALID_GUEST_ULID,
          accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        }),
      ).rejects.toThrow(InternalServerErrorException);

      expect(mockIdentityService.lookupOrCreateSession).not.toHaveBeenCalled();
    });

    it("fires notifyConversationStarted when wasCreated is true", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        budgetCents: null,
        wasCreated: true,
      });

      await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(mockSlackAlertService.notifyConversationStarted).toHaveBeenCalledTimes(1);
      const [callArgs] = mockSlackAlertService.notifyConversationStarted.mock.calls[0];
      expect(callArgs.accountId).toBe(VALID_ACCOUNT_ULID);
      expect(callArgs.sessionUlid).toBe(VALID_SESSION_ULID);
    });

    it("does NOT fire notifyConversationStarted when wasCreated is false (resumed session)", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });

      await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(mockSlackAlertService.notifyConversationStarted).not.toHaveBeenCalled();
    });

    it("returns the session response even when notifyConversationStarted rejects", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        budgetCents: null,
        wasCreated: true,
      });
      mockSlackAlertService.notifyConversationStarted.mockRejectedValue(new Error("Slack down"));

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.sessionUlid).toBe(VALID_SESSION_ULID);
    });

    it("pipe rejects body missing accountUlid", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({ agentName: AGENT_NAME, guestUlid: VALID_GUEST_ULID }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects accountUlid missing the A# prefix", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({ agentName: AGENT_NAME, guestUlid: VALID_GUEST_ULID, accountUlid: VALID_ACCOUNT_ULID }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects accountUlid with a wrong-length ULID segment", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({ agentName: AGENT_NAME, guestUlid: VALID_GUEST_ULID, accountUlid: "A#TOO_SHORT" }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects invalid guestUlid shape", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({
          agentName: AGENT_NAME,
          guestUlid: "not-a-ulid",
          accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe("POST /sessions/:sessionUlid/onboarding — completeOnboarding", () => {
    it("calls IdentityService.updateOnboarding with the ULID and budgetCents", async () => {
      mockIdentityService.updateOnboarding.mockResolvedValue({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        kickoffCompletedAt: null,
        budgetCents: 100_000,
      });

      const result = await controller.completeOnboarding(VALID_SESSION_ULID, { budgetCents: 100_000 });

      expect(result).toEqual({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        kickoffCompletedAt: null,
        budgetCents: 100_000,
      });

      expect(mockIdentityService.updateOnboarding).toHaveBeenCalledWith(VALID_SESSION_ULID, 100_000);
    });

    it("maps ConditionalCheckFailedException to a 404 NotFoundException", async () => {
      const conditionalError = Object.assign(new Error("Condition failed"), {
        name: "ConditionalCheckFailedException",
      });

      mockIdentityService.updateOnboarding.mockRejectedValue(conditionalError);

      await expect(
        controller.completeOnboarding(VALID_SESSION_ULID, { budgetCents: 50_000 }),
      ).rejects.toThrow(NotFoundException);
    });

    it("maps other DynamoDB errors to a 500 InternalServerErrorException", async () => {
      mockIdentityService.updateOnboarding.mockRejectedValue(new Error("unexpected"));

      await expect(
        controller.completeOnboarding(VALID_SESSION_ULID, { budgetCents: 50_000 }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it("pipe rejects non-integer budgetCents", () => {
      const pipe = new ZodValidationPipe(onboardingSchema);
      expect(() => pipe.transform({ budgetCents: 1.5 })).toThrow(BadRequestException);
    });

    it("pipe rejects zero or negative budgetCents", () => {
      const pipe = new ZodValidationPipe(onboardingSchema);
      expect(() => pipe.transform({ budgetCents: 0 })).toThrow(BadRequestException);
      expect(() => pipe.transform({ budgetCents: -100 })).toThrow(BadRequestException);
    });

    it("pipe rejects budgetCents over the $1M cap", () => {
      const pipe = new ZodValidationPipe(onboardingSchema);
      expect(() => pipe.transform({ budgetCents: 100_000_001 })).toThrow(BadRequestException);
    });

    it("param pipe rejects invalid sessionUlid", () => {
      const pipe = new ZodValidationPipe(sessionUlidParamSchema);
      expect(() => pipe.transform("not-a-ulid")).toThrow(BadRequestException);
    });
  });

  describe("GET /sessions/:sessionUlid/messages — getMessages", () => {
    it("returns the filtered history from ChatSessionService", async () => {
      const history = [
        { id: "01AAAAAAAAAAAAAAAAAAAAAAAA", role: "user" as const, content: "Hi", timestamp: "2026-04-19T20:00:00.000Z" },
        { id: "01BBBBBBBBBBBBBBBBBBBBBBBB", role: "assistant" as const, content: "Hello!", timestamp: "2026-04-19T20:00:01.000Z" },
      ];

      mockChatSessionService.getHistoryForClient.mockResolvedValue(history);

      const result = await controller.getMessages(VALID_SESSION_ULID);

      expect(result).toEqual({ messages: history });
      expect(mockChatSessionService.getHistoryForClient).toHaveBeenCalledWith(VALID_SESSION_ULID);
    });

    it("returns an empty messages array when no history exists", async () => {
      mockChatSessionService.getHistoryForClient.mockResolvedValue([]);

      const result = await controller.getMessages(VALID_SESSION_ULID);

      expect(result).toEqual({ messages: [] });
    });
  });

  describe("POST /messages — sendMessage", () => {
    it("returns reply on valid request when no tools fired", async () => {
      mockChatSessionService.handleMessage.mockResolvedValue({
        reply: "Hello from the assistant.",
        toolOutputs: [],
      });

      const result = await controller.sendMessage({ sessionUlid: VALID_SESSION_ULID, message: "Hi there" });

      expect(result).toEqual({ reply: "Hello from the assistant." });
      expect(result).not.toHaveProperty("tool_outputs");
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(VALID_SESSION_ULID, "Hi there");
    });

    it("includes tool_outputs on the wire when tools fired during the turn", async () => {
      mockChatSessionService.handleMessage.mockResolvedValue({
        reply: "Here's your cart.",
        toolOutputs: [
          { call_id: "toolu_01", tool_name: "preview_cart", content: '{"cart_id":"01CARTULID0000000000000000","item_count":1,"currency":"usd","cart_total":22500,"lines":[]}' },
        ],
      });

      const result = await controller.sendMessage({ sessionUlid: VALID_SESSION_ULID, message: "add that" });

      expect(result).toEqual({
        reply: "Here's your cart.",
        tool_outputs: [
          { call_id: "toolu_01", tool_name: "preview_cart", content: '{"cart_id":"01CARTULID0000000000000000","item_count":1,"currency":"usd","cart_total":22500,"lines":[]}' },
        ],
      });
    });

    it("throws BadRequestException for empty message (pipe)", () => {
      const pipe = new ZodValidationPipe(sendMessageSchema);

      expect(() =>
        pipe.transform({ sessionUlid: VALID_SESSION_ULID, message: "" }),
      ).toThrow(BadRequestException);
    });
  });

  describe("POST /embed/authorize — embedAuthorize", () => {
    const VALID_PARENT_DOMAIN = "example.com";

    it("returns { authorized: true } (HTTP 200) when service authorizes the domain", async () => {
      mockOriginAllowlistService.isOriginAuthorizedForAccount.mockResolvedValue(true);

      const result = await controller.embedAuthorize({
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        parentDomain: VALID_PARENT_DOMAIN,
      });

      expect(result).toEqual({ authorized: true });
    });

    it("returns { authorized: false } (HTTP 200) when service denies the domain — no exception thrown", async () => {
      mockOriginAllowlistService.isOriginAuthorizedForAccount.mockResolvedValue(false);

      const result = await controller.embedAuthorize({
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        parentDomain: VALID_PARENT_DOMAIN,
      });

      expect(result).toEqual({ authorized: false });
    });

    it("strips the A# prefix before calling the service (service never receives the prefixed form)", async () => {
      mockOriginAllowlistService.isOriginAuthorizedForAccount.mockResolvedValue(true);

      await controller.embedAuthorize({
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        parentDomain: VALID_PARENT_DOMAIN,
      });

      expect(mockOriginAllowlistService.isOriginAuthorizedForAccount).toHaveBeenCalledWith(
        VALID_ACCOUNT_ULID,
        VALID_PARENT_DOMAIN,
      );
      expect(mockOriginAllowlistService.isOriginAuthorizedForAccount).not.toHaveBeenCalledWith(
        VALID_ACCOUNT_ULID_WITH_PREFIX,
        VALID_PARENT_DOMAIN,
      );
    });

    it("pipe rejects missing accountUlid", () => {
      const pipe = new ZodValidationPipe(embedAuthorizeSchema);

      expect(() =>
        pipe.transform({ parentDomain: VALID_PARENT_DOMAIN }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects missing parentDomain", () => {
      const pipe = new ZodValidationPipe(embedAuthorizeSchema);

      expect(() =>
        pipe.transform({ accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects malformed accountUlid (missing A# prefix)", () => {
      const pipe = new ZodValidationPipe(embedAuthorizeSchema);

      expect(() =>
        pipe.transform({ accountUlid: VALID_ACCOUNT_ULID, parentDomain: VALID_PARENT_DOMAIN }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects parentDomain with a scheme ('https://example.com')", () => {
      const pipe = new ZodValidationPipe(embedAuthorizeSchema);

      expect(() =>
        pipe.transform({ accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX, parentDomain: "https://example.com" }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects parentDomain with a port ('example.com:8080')", () => {
      const pipe = new ZodValidationPipe(embedAuthorizeSchema);

      expect(() =>
        pipe.transform({ accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX, parentDomain: "example.com:8080" }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects empty string parentDomain", () => {
      const pipe = new ZodValidationPipe(embedAuthorizeSchema);

      expect(() =>
        pipe.transform({ accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX, parentDomain: "" }),
      ).toThrow(BadRequestException);
    });
  });
});
