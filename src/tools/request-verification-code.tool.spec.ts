import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "crypto";

import { RequestVerificationCodeTool } from "./request-verification-code.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { EmailService } from "../services/email.service";

const TABLE_NAME = "test-conversations-table";
const SESSION_ULID = "01TESTSESSION0000000000000";
const CUSTOMER_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const mockEmailService = {
  send: jest.fn(),
};

const TEST_CONTEXT = { sessionUlid: SESSION_ULID };

function makeContactInfoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "USER_CONTACT_INFO",
    email: "visitor@example.com",
    ...overrides,
  };
}

function makeVerificationCodeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "VERIFICATION_CODE",
    entity: "VERIFICATION_CODE",
    code_hash: "abc123hash",
    email: "visitor@example.com",
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    attempts: 0,
    request_count_in_window: 1,
    request_window_start_at: tenMinutesAgo,
    ttl: Math.floor(Date.now() / 1000) + 600,
    _createdAt_: tenMinutesAgo,
    _lastUpdated_: tenMinutesAgo,
    ...overrides,
  };
}

function makeMetadataItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "METADATA",
    _createdAt_: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
    customer_id: `C#${CUSTOMER_ULID}`,
    ...overrides,
  };
}

function makeCustomerItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `C#${CUSTOMER_ULID}`,
    SK: `C#${CUSTOMER_ULID}`,
    entity: "CUSTOMER",
    _createdAt_: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 1 week ago
    ...overrides,
  };
}

describe("RequestVerificationCodeTool", () => {
  let tool: RequestVerificationCodeTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    mockEmailService.send.mockResolvedValue({ messageId: "msg-001" });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestVerificationCodeTool,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        {
          provide: DatabaseConfigService,
          useValue: mockDatabaseConfig,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
      ],
    }).compile();

    tool = module.get<RequestVerificationCodeTool>(RequestVerificationCodeTool);
  });

  describe("execute", () => {
    it("1 — happy path: returns { sent: true }, writes VERIFICATION_CODE record, sends email", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: undefined });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}` } })
        .resolves({ Item: makeCustomerItem() });

      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(true);

      // PutCommand called with correct fields
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item;
      expect(item?.PK).toBe(`CHAT_SESSION#${SESSION_ULID}`);
      expect(item?.SK).toBe("VERIFICATION_CODE");
      expect(item?.entity).toBe("VERIFICATION_CODE");
      expect(typeof item?.code_hash).toBe("string");
      expect((item?.code_hash as string).length).toBe(64); // SHA-256 hex
      expect(item?.email).toBe("visitor@example.com");
      expect(item?.attempts).toBe(0);
      expect(item?.request_count_in_window).toBe(1);
      expect(typeof item?.expires_at).toBe("string");
      expect(typeof item?.ttl).toBe("number");

      // EmailService.send called with correct subject and non-empty body
      expect(mockEmailService.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockEmailService.send.mock.calls[0][0];
      expect(sendArgs.subject).toBe("Your verification code");
      expect(sendArgs.to).toBe("visitor@example.com");
      expect(sendArgs.sessionUlid).toBe(SESSION_ULID);
      expect(sendArgs.body).toContain("verification code");
    });

    it("2 — no email in session: returns { sent: false, reason: 'no_email_in_session' }", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem({ email: "" }) });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(false);
      expect(parsed.reason).toBe("no_email_in_session");

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(mockEmailService.send).not.toHaveBeenCalled();
    });

    it("3 — rate-limited: 4th request in window returns { sent: false, reason: 'rate_limited' }", async () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({
          Item: makeVerificationCodeItem({
            request_count_in_window: 3,
            request_window_start_at: tenMinutesAgo,
          }),
        });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(false);
      expect(parsed.reason).toBe("rate_limited");

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(mockEmailService.send).not.toHaveBeenCalled();
    });

    it("4 — window expired (>1h ago): counter resets to 1, returns { sent: true }", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({
          Item: makeVerificationCodeItem({
            request_count_in_window: 3,
            request_window_start_at: twoHoursAgo,
          }),
        });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}` } })
        .resolves({ Item: makeCustomerItem() });

      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(true);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item;
      expect(item?.request_count_in_window).toBe(1);
    });

    it("5 — email send failure: returns { sent: false, reason: 'send_failed' }, PutCommand NOT called", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: undefined });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}` } })
        .resolves({ Item: makeCustomerItem() });

      mockEmailService.send.mockRejectedValue(new Error("SendGrid unavailable"));

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(false);
      expect(parsed.reason).toBe("send_failed");

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(mockEmailService.send).toHaveBeenCalledTimes(1);
    });

    it("6 — zero-padding preserved: code in email body and DDB hash are consistent", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: undefined });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}` } })
        .resolves({ Item: makeCustomerItem() });

      ddbMock.on(PutCommand).resolves({});

      await tool.execute({}, TEST_CONTEXT);

      // Capture the code from the email body
      const sendArgs = mockEmailService.send.mock.calls[0][0];
      const emailBody: string = sendArgs.body;

      // Extract the 6-digit code from the <h2> tag in the email body
      const codeMatch = emailBody.match(/<h2[^>]*>(\d{6})<\/h2>/);
      expect(codeMatch).not.toBeNull();
      const codeInEmail = codeMatch![1];

      // The code must be exactly 6 characters
      expect(codeInEmail).toHaveLength(6);
      expect(/^\d{6}$/.test(codeInEmail)).toBe(true);

      // The SHA-256 of the zero-padded code must match what was written to DDB
      const putCalls = ddbMock.commandCalls(PutCommand);
      const storedHash = putCalls[0].args[0].input.Item?.code_hash as string;
      const expectedHash = createHash("sha256").update(codeInEmail).digest("hex");
      expect(storedHash).toBe(expectedHash);
    });

    it("7 — guard: customer_id null on METADATA returns { sent: false, reason: 'no_existing_customer_to_verify' }", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: undefined });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem({ customer_id: null }) });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(false);
      expect(parsed.reason).toBe("no_existing_customer_to_verify");

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(mockEmailService.send).not.toHaveBeenCalled();
    });

    it("8 — guard: customer _createdAt_ AFTER session _createdAt_ returns { sent: false, reason: 'no_existing_customer_to_verify' }", async () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: undefined });

      // Session was created 5 minutes ago; customer was created 1 minute ago (newer than session — new visitor)
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem({ _createdAt_: fiveMinutesAgo }) });

      ddbMock
        .on(GetCommand, { Key: { PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}` } })
        .resolves({ Item: makeCustomerItem({ _createdAt_: oneMinuteAgo }) });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(false);
      expect(parsed.reason).toBe("no_existing_customer_to_verify");

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(mockEmailService.send).not.toHaveBeenCalled();
    });

    it("9 — guard: customer _createdAt_ BEFORE session _createdAt_ (returning visitor) allows through and sends email", async () => {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: undefined });

      // Session created 1 minute ago; customer created 1 week ago (clearly pre-existed — returning visitor)
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem({ _createdAt_: oneMinuteAgo }) });

      ddbMock
        .on(GetCommand, { Key: { PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}` } })
        .resolves({ Item: makeCustomerItem({ _createdAt_: oneWeekAgo }) });

      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.sent).toBe(true);

      expect(mockEmailService.send).toHaveBeenCalledTimes(1);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });
  });
});
