import { Test, TestingModule } from "@nestjs/testing";

import { InternalEmailFlushController } from "./internal-email-flush.controller";
import { InternalAuthGuard } from "../guards/internal-auth.guard";
import { ReplyOrchestratorService } from "../services/reply-orchestrator.service";

const SESSION_ULID = "01FLUSHSESSN0000000000000000";

const mockReplyOrchestratorService = {
  generateAndSendReply: jest.fn(),
};

describe("InternalEmailFlushController", () => {
  let controller: InternalEmailFlushController;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockReplyOrchestratorService.generateAndSendReply.mockResolvedValue({
      outcome: "replied",
      reply: "Hello!",
      toolOutputs: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalEmailFlushController],
      providers: [
        {
          provide: ReplyOrchestratorService,
          useValue: mockReplyOrchestratorService,
        },
      ],
    })
      .overrideGuard(InternalAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get<InternalEmailFlushController>(InternalEmailFlushController);
  });

  // ---------------------------------------------------------------------------
  // Happy path — guard passes, controller dispatches to orchestrator
  // ---------------------------------------------------------------------------

  describe("POST /internal/email-flush/:sessionUlid — happy path", () => {
    it("calls generateAndSendReply with (sessionUlid, 'email') when guard passes", async () => {
      await controller.handleEmailFlush(SESSION_ULID, { sessionUlid: SESSION_ULID });

      expect(mockReplyOrchestratorService.generateAndSendReply).toHaveBeenCalledWith(
        SESSION_ULID,
        "email",
      );
    });

    it("returns void (no response body) after dispatching", async () => {
      const result = await controller.handleEmailFlush(SESSION_ULID, { sessionUlid: SESSION_ULID });

      expect(result).toBeUndefined();
    });

    it("uses sessionUlid from path param, not from request body", async () => {
      const pathParam = SESSION_ULID;
      const bodyParam = "01DIFFERENTBODYSESS0000000000";

      await controller.handleEmailFlush(pathParam, { sessionUlid: bodyParam });

      expect(mockReplyOrchestratorService.generateAndSendReply).toHaveBeenCalledWith(
        pathParam,
        "email",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Error propagation
  // ---------------------------------------------------------------------------

  describe("POST /internal/email-flush/:sessionUlid — error propagation", () => {
    it("propagates errors thrown by generateAndSendReply without catching", async () => {
      mockReplyOrchestratorService.generateAndSendReply.mockRejectedValue(
        new Error("Orchestrator failure"),
      );

      await expect(
        controller.handleEmailFlush(SESSION_ULID, { sessionUlid: SESSION_ULID }),
      ).rejects.toThrow("Orchestrator failure");
    });
  });
});
