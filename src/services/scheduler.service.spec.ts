import { Test, TestingModule } from "@nestjs/testing";
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand } from "@aws-sdk/client-scheduler";
import { mockClient } from "aws-sdk-client-mock";

import { SchedulerService } from "./scheduler.service";
import { SchedulerConfigService } from "./scheduler-config.service";
import { DatabaseConfigService } from "./database-config.service";

const mockSchedulerConfig = {
  backend: "real",
  roleArn: "arn:aws:iam::123456789012:role/scheduler-role",
  apiDestinationArn: "arn:aws:events::123456789012:api-destination/flush/abc",
};

const mockDatabaseConfig = {
  conversationsTable: "test-conversations-table",
  region: "us-east-1",
};

const SESSION_ULID = "01SESSN00000000000000000000";

// aws-sdk-client-mock patches the prototype, so we mock at the class level.
const schedulerMock = mockClient(SchedulerClient);

describe("SchedulerService", () => {
  let service: SchedulerService;

  beforeEach(async () => {
    schedulerMock.reset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: SchedulerConfigService, useValue: mockSchedulerConfig },
        { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
  });

  // ---------------------------------------------------------------------------
  // createOrResetEmailFlush — happy path
  // ---------------------------------------------------------------------------

  describe("createOrResetEmailFlush — happy path", () => {
    it("sends DeleteScheduleCommand then CreateScheduleCommand on success", async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).resolves({ ScheduleArn: "arn:aws:scheduler::123:schedule/default/email-flush-01SESS" });

      const fireAtMs = Date.now() + 90_000;

      await service.createOrResetEmailFlush(SESSION_ULID, fireAtMs);

      const deleteCalls = schedulerMock.commandCalls(DeleteScheduleCommand);
      const createCalls = schedulerMock.commandCalls(CreateScheduleCommand);

      expect(deleteCalls).toHaveLength(1);
      expect(createCalls).toHaveLength(1);
      expect(deleteCalls[0].args[0].input.Name).toBe(`email-flush-${SESSION_ULID}`);
      expect(createCalls[0].args[0].input.Name).toBe(`email-flush-${SESSION_ULID}`);
    });

    it("sets ActionAfterCompletion to DELETE on the created schedule", async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).resolves({});

      await service.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000);

      const createInput = schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input;
      expect(createInput.ActionAfterCompletion).toBe("DELETE");
    });

    it("encodes sessionUlid in the Target Input JSON", async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).resolves({});

      await service.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000);

      const createInput = schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input;
      const parsedTarget = JSON.parse(createInput.Target!.Input!);

      expect(parsedTarget.sessionUlid).toBe(SESSION_ULID);
    });
  });

  // ---------------------------------------------------------------------------
  // createOrResetEmailFlush — swallows ResourceNotFoundException on delete
  // ---------------------------------------------------------------------------

  describe("createOrResetEmailFlush — swallows ResourceNotFoundException on delete", () => {
    it("does not throw when DeleteScheduleCommand returns ResourceNotFoundException", async () => {
      const notFoundError = Object.assign(new Error("Schedule not found"), {
        name: "ResourceNotFoundException",
      });

      schedulerMock.on(DeleteScheduleCommand).rejects(notFoundError);
      schedulerMock.on(CreateScheduleCommand).resolves({});

      await expect(service.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000)).resolves.toBeUndefined();

      // CreateScheduleCommand must still be called even when delete 404s
      expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // createOrResetEmailFlush — ConflictException on create → one retry
  // ---------------------------------------------------------------------------

  describe("createOrResetEmailFlush — ConflictException on first create, retry succeeds", () => {
    it("retries delete-then-create once when ConflictException is thrown on initial create", async () => {
      const conflictError = Object.assign(new Error("Schedule already exists"), {
        name: "ConflictException",
      });

      // First delete: succeeds. First create: conflicts. Second delete: succeeds. Second create: succeeds.
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock
        .on(CreateScheduleCommand)
        .rejectsOnce(conflictError)
        .resolves({});

      await expect(service.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000)).resolves.toBeUndefined();

      // Two deletes (one before first create, one before retry create) + two create attempts
      expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(2);
      expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // createOrResetEmailFlush — second ConflictException on retry rethrows
  // ---------------------------------------------------------------------------

  describe("createOrResetEmailFlush — second ConflictException rethrows", () => {
    it("propagates the error when CreateScheduleCommand throws ConflictException on both attempts", async () => {
      const conflictError = Object.assign(new Error("Schedule already exists"), {
        name: "ConflictException",
      });

      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).rejects(conflictError);

      await expect(service.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000)).rejects.toMatchObject({
        name: "ConflictException",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // cancelEmailFlush — happy path
  // ---------------------------------------------------------------------------

  describe("cancelEmailFlush — happy path", () => {
    it("sends DeleteScheduleCommand with the correct name", async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});

      await service.cancelEmailFlush(SESSION_ULID);

      const calls = schedulerMock.commandCalls(DeleteScheduleCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Name).toBe(`email-flush-${SESSION_ULID}`);
    });
  });

  // ---------------------------------------------------------------------------
  // cancelEmailFlush — swallows ResourceNotFoundException
  // ---------------------------------------------------------------------------

  describe("cancelEmailFlush — swallows ResourceNotFoundException", () => {
    it("does not throw when DeleteScheduleCommand returns ResourceNotFoundException", async () => {
      const notFoundError = Object.assign(new Error("Schedule not found"), {
        name: "ResourceNotFoundException",
      });

      schedulerMock.on(DeleteScheduleCommand).rejects(notFoundError);

      await expect(service.cancelEmailFlush(SESSION_ULID)).resolves.toBeUndefined();
    });

    it("propagates non-ResourceNotFoundException errors", async () => {
      const otherError = Object.assign(new Error("Service unavailable"), {
        name: "ServiceUnavailableException",
      });

      schedulerMock.on(DeleteScheduleCommand).rejects(otherError);

      await expect(service.cancelEmailFlush(SESSION_ULID)).rejects.toMatchObject({
        name: "ServiceUnavailableException",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getEmailFlushFireTime — returns parsed epoch ms on success
  // ---------------------------------------------------------------------------

  describe("getEmailFlushFireTime — success", () => {
    it("parses the at() expression and returns epoch milliseconds", async () => {
      // at(2026-05-12T10:30:00) UTC → 1747045800000 ms
      schedulerMock.on(GetScheduleCommand).resolves({
        ScheduleExpression: "at(2026-05-12T10:30:00)",
      });

      const result = await service.getEmailFlushFireTime(SESSION_ULID);

      // Just verify it's a valid timestamp in a reasonable range
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThan(0);
      // The returned time should correspond to 2026-05-12T10:30:00Z
      expect(result).toBe(new Date("2026-05-12T10:30:00Z").getTime());
    });

    it("queries with the correct schedule name", async () => {
      schedulerMock.on(GetScheduleCommand).resolves({
        ScheduleExpression: "at(2026-05-12T10:30:00)",
      });

      await service.getEmailFlushFireTime(SESSION_ULID);

      const calls = schedulerMock.commandCalls(GetScheduleCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Name).toBe(`email-flush-${SESSION_ULID}`);
    });

    it("returns null when ScheduleExpression does not contain a valid at() timestamp", async () => {
      schedulerMock.on(GetScheduleCommand).resolves({
        ScheduleExpression: "rate(5 minutes)",
      });

      const result = await service.getEmailFlushFireTime(SESSION_ULID);

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getEmailFlushFireTime — returns null on ResourceNotFoundException
  // ---------------------------------------------------------------------------

  describe("getEmailFlushFireTime — ResourceNotFoundException returns null", () => {
    it("returns null when GetScheduleCommand throws ResourceNotFoundException", async () => {
      const notFoundError = Object.assign(new Error("Schedule not found"), {
        name: "ResourceNotFoundException",
      });

      schedulerMock.on(GetScheduleCommand).rejects(notFoundError);

      const result = await service.getEmailFlushFireTime(SESSION_ULID);

      expect(result).toBeNull();
    });

    it("propagates non-ResourceNotFoundException errors from GetScheduleCommand", async () => {
      const otherError = Object.assign(new Error("Access denied"), {
        name: "AccessDeniedException",
      });

      schedulerMock.on(GetScheduleCommand).rejects(otherError);

      await expect(service.getEmailFlushFireTime(SESSION_ULID)).rejects.toMatchObject({
        name: "AccessDeniedException",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // toUtcSchedulerString helper — format verification via createOrResetEmailFlush
  // ---------------------------------------------------------------------------

  describe("schedule expression format", () => {
    it("produces at(YYYY-MM-DDTHH:mm:ss) UTC format in the ScheduleExpression", async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).resolves({});

      // Use a fixed point in time: 2026-05-12T10:30:45.000Z
      const fireAtMs = new Date("2026-05-12T10:30:45.000Z").getTime();

      await service.createOrResetEmailFlush(SESSION_ULID, fireAtMs);

      const createInput = schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input;
      expect(createInput.ScheduleExpression).toBe("at(2026-05-12T10:30:45)");
      expect(createInput.ScheduleExpressionTimezone).toBe("UTC");
    });
  });
});
