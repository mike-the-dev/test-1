import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { ChannelAddressService } from "./channel-address.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { ChannelAddressType } from "../types/AccountChannel";

const TABLE_NAME = "test-conversations-table";
const ACCOUNT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EMAIL_DOMAIN = "reply.example.com";
const PHONE_NUMBER = "+15551234567";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

describe("ChannelAddressService", () => {
  let service: ChannelAddressService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAddressService,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        {
          provide: DatabaseConfigService,
          useValue: mockDatabaseConfig,
        },
      ],
    }).compile();

    service = module.get<ChannelAddressService>(ChannelAddressService);
  });

  // ---------------------------------------------------------------------------
  // formatGsi1PkForChannel (via getAccountByChannelAddress observable behavior)
  // ---------------------------------------------------------------------------

  describe("GSI1-PK construction", () => {
    it("constructs EMAIL_REPLY_DOMAIN GSI1-PK as EMAIL_REPLY_DOMAIN#<domain>", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ PK: `A#${ACCOUNT_ID}`, entity: "ACCOUNT_CHANNEL_ADDRESS" }] });

      await service.getAccountByChannelAddress(ChannelAddressType.EMAIL_REPLY_DOMAIN, EMAIL_DOMAIN);

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const queryInput = calls[0].args[0].input;
      expect(queryInput.ExpressionAttributeValues?.[":pk"]).toBe(`EMAIL_REPLY_DOMAIN#${EMAIL_DOMAIN}`);
    });

    it("constructs TWILIO_NUMBER GSI1-PK as TWILIO_NUMBER#<phone>", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ PK: `A#${ACCOUNT_ID}`, entity: "ACCOUNT_CHANNEL_ADDRESS" }] });

      await service.getAccountByChannelAddress(ChannelAddressType.TWILIO_NUMBER, PHONE_NUMBER);

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const queryInput = calls[0].args[0].input;
      expect(queryInput.ExpressionAttributeValues?.[":pk"]).toBe(`TWILIO_NUMBER#${PHONE_NUMBER}`);
    });
  });

  // ---------------------------------------------------------------------------
  // getAccountByChannelAddress
  // ---------------------------------------------------------------------------

  describe("getAccountByChannelAddress", () => {
    it("happy path — returns accountId extracted from PK field", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `A#${ACCOUNT_ID}`, entity: "ACCOUNT_CHANNEL_ADDRESS" }],
      });

      const result = await service.getAccountByChannelAddress(
        ChannelAddressType.EMAIL_REPLY_DOMAIN,
        EMAIL_DOMAIN,
      );

      expect(result).toEqual({ accountId: ACCOUNT_ID });
    });

    it("returns null when GSI1 query returns no items", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await service.getAccountByChannelAddress(
        ChannelAddressType.EMAIL_REPLY_DOMAIN,
        EMAIL_DOMAIN,
      );

      expect(result).toBeNull();
    });

    it("returns null when GSI1 query returns undefined Items", async () => {
      ddbMock.on(QueryCommand).resolves({});

      const result = await service.getAccountByChannelAddress(
        ChannelAddressType.TWILIO_NUMBER,
        PHONE_NUMBER,
      );

      expect(result).toBeNull();
    });

    it("returns null when DynamoDB throws an error", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("DynamoDB service error"));

      const result = await service.getAccountByChannelAddress(
        ChannelAddressType.EMAIL_REPLY_DOMAIN,
        EMAIL_DOMAIN,
      );

      expect(result).toBeNull();
    });

    it("queries with the correct entity filter for ACCOUNT_CHANNEL_ADDRESS", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `A#${ACCOUNT_ID}`, entity: "ACCOUNT_CHANNEL_ADDRESS" }],
      });

      await service.getAccountByChannelAddress(ChannelAddressType.TWILIO_NUMBER, PHONE_NUMBER);

      const calls = ddbMock.commandCalls(QueryCommand);
      const queryInput = calls[0].args[0].input;
      expect(queryInput.ExpressionAttributeValues?.[":entity"]).toBe("ACCOUNT_CHANNEL_ADDRESS");
      expect(queryInput.Limit).toBe(1);
      expect(queryInput.IndexName).toBe("GSI1");
    });
  });

  // ---------------------------------------------------------------------------
  // provisionChannelAddress
  // ---------------------------------------------------------------------------

  describe("provisionChannelAddress", () => {
    it("happy path — returns { provisioned: true } and writes TransactWriteCommand", async () => {
      ddbMock.on(TransactWriteCommand).resolves({});

      const result = await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ provisioned: true });
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    it("happy path SMS — writes correct channel key 'sms' and addressArrayKey 'phone_numbers'", async () => {
      ddbMock.on(TransactWriteCommand).resolves({});

      await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.TWILIO_NUMBER,
        address: PHONE_NUMBER,
      });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const transactInput = calls[0].args[0].input;
      const updateItem = transactInput.TransactItems?.[1]?.Update;
      expect(updateItem?.ExpressionAttributeNames?.["#channel"]).toBe("sms");
      expect(updateItem?.ExpressionAttributeNames?.["#addressArray"]).toBe("phone_numbers");
    });

    it("email channel — writes correct channel key 'email' and addressArrayKey 'reply_domains'", async () => {
      ddbMock.on(TransactWriteCommand).resolves({});

      await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const transactInput = calls[0].args[0].input;
      const updateItem = transactInput.TransactItems?.[1]?.Update;
      expect(updateItem?.ExpressionAttributeNames?.["#channel"]).toBe("email");
      expect(updateItem?.ExpressionAttributeNames?.["#addressArray"]).toBe("reply_domains");
    });

    it("Put item has correct PK, SK, entity, GSI1-PK, GSI1-SK", async () => {
      ddbMock.on(TransactWriteCommand).resolves({});

      await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const transactInput = calls[0].args[0].input;
      const putItem = transactInput.TransactItems?.[0]?.Put?.Item;
      expect(putItem?.PK).toBe(`A#${ACCOUNT_ID}`);
      expect(putItem?.SK).toBe(`EMAIL_REPLY_DOMAIN#${EMAIL_DOMAIN}`);
      expect(putItem?.entity).toBe("ACCOUNT_CHANNEL_ADDRESS");
      expect(putItem?.["GSI1-PK"]).toBe(`EMAIL_REPLY_DOMAIN#${EMAIL_DOMAIN}`);
      expect(putItem?.["GSI1-SK"]).toBe(`ACCOUNT#${ACCOUNT_ID}`);
    });

    it("Put item has attribute_not_exists ConditionExpression", async () => {
      ddbMock.on(TransactWriteCommand).resolves({});

      await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const transactInput = calls[0].args[0].input;
      const putCondition = transactInput.TransactItems?.[0]?.Put?.ConditionExpression;
      expect(putCondition).toContain("attribute_not_exists(PK)");
      expect(putCondition).toContain("attribute_not_exists(SK)");
    });

    it("returns { error: 'address_already_provisioned' } when TransactionCanceledException with index-record-condition reason", async () => {
      const cancellationError = Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      });
      ddbMock.on(TransactWriteCommand).rejects(cancellationError);

      const result = await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ error: "address_already_provisioned" });
    });

    it("returns { error: 'provisioning_failed' } when TransactionCanceledException with non-index-record reason", async () => {
      const cancellationError = Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      });
      ddbMock.on(TransactWriteCommand).rejects(cancellationError);

      const result = await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ error: "provisioning_failed" });
    });

    it("returns { error: 'provisioning_failed' } on other DDB errors", async () => {
      ddbMock.on(TransactWriteCommand).rejects(new Error("DynamoDB service error"));

      const result = await service.provisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ error: "provisioning_failed" });
    });
  });

  // ---------------------------------------------------------------------------
  // deprovisionChannelAddress
  // ---------------------------------------------------------------------------

  describe("deprovisionChannelAddress", () => {
    it("happy path — returns { deprovisioned: true } and writes TransactWriteCommand", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { channels: { email: { reply_domains: [EMAIL_DOMAIN] } } },
      });
      ddbMock.on(TransactWriteCommand).resolves({});

      const result = await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ deprovisioned: true });
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    it("Delete item has correct key and attribute_exists ConditionExpression", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { channels: { email: { reply_domains: [EMAIL_DOMAIN] } } },
      });
      ddbMock.on(TransactWriteCommand).resolves({});

      await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const transactInput = calls[0].args[0].input;
      const deleteItem = transactInput.TransactItems?.[0]?.Delete;
      expect(deleteItem?.Key?.PK).toBe(`A#${ACCOUNT_ID}`);
      expect(deleteItem?.Key?.SK).toBe(`EMAIL_REPLY_DOMAIN#${EMAIL_DOMAIN}`);
      expect(deleteItem?.ConditionExpression).toContain("attribute_exists(PK)");
    });

    it("returns { error: 'address_not_found' } when index record does not exist (ConditionalCheckFailed on Delete)", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { channels: { email: { reply_domains: [EMAIL_DOMAIN] } } },
      });
      const cancellationError = Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      });
      ddbMock.on(TransactWriteCommand).rejects(cancellationError);

      const result = await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ error: "address_not_found" });
    });

    it("returns { error: 'deprovisioning_failed' } on other DDB errors", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { channels: { sms: { phone_numbers: [PHONE_NUMBER] } } },
      });
      ddbMock.on(TransactWriteCommand).rejects(new Error("DynamoDB service error"));

      const result = await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.TWILIO_NUMBER,
        address: PHONE_NUMBER,
      });

      expect(result).toEqual({ error: "deprovisioning_failed" });
    });

    it("deprovisions the second of two addresses correctly — removes index 1, leaves index 0 in place", async () => {
      const SECOND_DOMAIN = "reply2.example.com";
      ddbMock.on(GetCommand).resolves({
        Item: { channels: { email: { reply_domains: [EMAIL_DOMAIN, SECOND_DOMAIN] } } },
      });
      ddbMock.on(TransactWriteCommand).resolves({});

      const result = await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: SECOND_DOMAIN,
      });

      expect(result).toEqual({ deprovisioned: true });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const updateItem = calls[0].args[0].input.TransactItems?.[1]?.Update;
      // Must target index 1, not index 0 (expression uses attribute name placeholders)
      expect(updateItem?.UpdateExpression).toContain("#addressArray[1]");
    });

    it("deprovisions the only address — array index 0 is targeted in the UpdateExpression", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { channels: { email: { reply_domains: [EMAIL_DOMAIN] } } },
      });
      ddbMock.on(TransactWriteCommand).resolves({});

      const result = await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ deprovisioned: true });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const updateItem = calls[0].args[0].input.TransactItems?.[1]?.Update;
      expect(updateItem?.UpdateExpression).toContain("#addressArray[0]");
    });

    it("deprovisions an address not in the array — only bumps _lastUpdated_, no REMOVE clause", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { channels: { email: { reply_domains: [] } } },
      });
      ddbMock.on(TransactWriteCommand).resolves({});

      const result = await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ deprovisioned: true });

      const calls = ddbMock.commandCalls(TransactWriteCommand);
      const updateItem = calls[0].args[0].input.TransactItems?.[1]?.Update;
      // No REMOVE clause — only SET for _lastUpdated_
      expect(updateItem?.UpdateExpression).not.toContain("REMOVE");
      expect(updateItem?.UpdateExpression).toContain("SET #lastUpdated = :now");
    });

    it("returns { error: 'deprovisioning_failed' } when GetCommand throws", async () => {
      ddbMock.on(GetCommand).rejects(new Error("DynamoDB service error"));

      const result = await service.deprovisionChannelAddress({
        accountId: ACCOUNT_ID,
        channelType: ChannelAddressType.EMAIL_REPLY_DOMAIN,
        address: EMAIL_DOMAIN,
      });

      expect(result).toEqual({ error: "deprovisioning_failed" });
      // TransactWrite should not be called if GetItem failed
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
  });
});
