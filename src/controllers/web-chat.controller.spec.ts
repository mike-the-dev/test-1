import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ChatSessionService } from "../services/chat-session.service";
import { IdentityService } from "../services/identity.service";
import { OriginAllowlistService } from "../services/origin-allowlist.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import { createSessionSchema, sendMessageSchema } from "../validation/web-chat.schema";
import { WebChatController } from "./web-chat.controller";

const VALID_GUEST_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_SESSION_ULID = "01BX5ZZKBKACTAV9WEVGEMMVS1";
const VALID_ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const VALID_ACCOUNT_ULID_WITH_PREFIX = `A#${VALID_ACCOUNT_ULID}`;
const AGENT_NAME = "lead_capture";

const mockIdentityService = {
  lookupOrCreateSession: jest.fn(),
};

const mockChatSessionService = {
  handleMessage: jest.fn(),
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

    it("returns sessionUlid and displayName on valid request with displayName set", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue(VALID_SESSION_ULID);

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result).toEqual({ sessionUlid: VALID_SESSION_ULID, displayName: "Lead Capture Assistant" });
      expect(mockIdentityService.lookupOrCreateSession).toHaveBeenCalledWith(
        "web",
        VALID_GUEST_ULID,
        AGENT_NAME,
        VALID_ACCOUNT_ULID,
      );
    });

    it("falls back to agent.name when displayName is not set", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: undefined });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue(VALID_SESSION_ULID);

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.displayName).toBe(AGENT_NAME);
    });

    it("strips the A# prefix from body.accountUlid before calling verifyAccountActive", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue(VALID_SESSION_ULID);

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
