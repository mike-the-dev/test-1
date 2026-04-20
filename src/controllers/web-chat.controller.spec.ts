import { BadRequestException, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ChatSessionService } from "../services/chat-session.service";
import { IdentityService } from "../services/identity.service";
import { OriginAllowlistService } from "../services/origin-allowlist.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import {
  createSessionSchema,
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
};

describe("WebChatController", () => {
  let controller: WebChatController;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockOriginAllowlistService.verifyAccountActive.mockResolvedValue(VALID_ACCOUNT_ULID);
    mockIdentityService.lookupOrCreateSession.mockResolvedValue({
      sessionUlid: VALID_SESSION_ULID,
      onboardingCompletedAt: null,
      budgetCents: null,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebChatController],
      providers: [
        { provide: IdentityService, useValue: mockIdentityService },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: AgentRegistryService, useValue: mockAgentRegistry },
        { provide: OriginAllowlistService, useValue: mockOriginAllowlistService },
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
        budgetCents: 100_000,
      });

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.onboardingCompletedAt).toBe("2026-04-19T20:00:00.000Z");
      expect(result.budgetCents).toBe(100_000);
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
        budgetCents: 100_000,
      });

      const result = await controller.completeOnboarding(VALID_SESSION_ULID, { budgetCents: 100_000 });

      expect(result).toEqual({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
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
    it("returns reply on valid request", async () => {
      mockChatSessionService.handleMessage.mockResolvedValue("Hello from the assistant.");

      const result = await controller.sendMessage({ sessionUlid: VALID_SESSION_ULID, message: "Hi there" });

      expect(result).toEqual({ reply: "Hello from the assistant." });
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(VALID_SESSION_ULID, "Hi there");
    });

    it("throws BadRequestException for empty message (pipe)", () => {
      const pipe = new ZodValidationPipe(sendMessageSchema);

      expect(() =>
        pipe.transform({ sessionUlid: VALID_SESSION_ULID, message: "" }),
      ).toThrow(BadRequestException);
    });
  });
});
