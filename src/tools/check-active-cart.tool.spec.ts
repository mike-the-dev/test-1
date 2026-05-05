import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { CheckActiveCartTool } from "./check-active-cart.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatToolExecutionContext } from "../types/Tool";

const TABLE_NAME = "test-conversations-table";

// Crockford-valid 26-char ULIDs (no I, L, O, U)
const SESSION_ULID = "01HXYZ3MNPQRSTVWXY3MNPQRST";
const ACCOUNT_ULID = "01HXYZ3MNPQRSTVWXY3MNPQRSA";
const PRIOR_SESSION_ULID = "01HXYZ3MNPQRSTVWXY3MNPQRSB";
const CUSTOMER_ID = "C#01HXYZ3MNPQRSTVWXY3MNPQRSC";
const CART_ID_PREFIXED = "C#01HXYZ3MNPQRSTVWXY3MNPQRSD";
const CART_ID_BARE = "01HXYZ3MNPQRSTVWXY3MNPQRSD";
const GUEST_ID_PREFIXED = "G#01HXYZ3MNPQRSTVWXY3MNPQRSE";
const GUEST_ID_BARE = "01HXYZ3MNPQRSTVWXY3MNPQRSE";

const LAST_UPDATED = "2026-04-01T12:00:00.000Z";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const TEST_CONTEXT = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

function makeCurrentMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "METADATA",
    customer_id: CUSTOMER_ID,
    continuation_from_session_id: `CHAT_SESSION#${PRIOR_SESSION_ULID}`,
    _createdAt_: "2026-04-01T10:00:00.000Z",
    _lastUpdated_: "2026-04-01T10:00:00.000Z",
    ...overrides,
  };
}

function makePriorMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${PRIOR_SESSION_ULID}`,
    SK: "METADATA",
    customer_id: CUSTOMER_ID,
    cart_id: CART_ID_PREFIXED,
    guest_id: GUEST_ID_PREFIXED,
    _createdAt_: "2026-03-15T10:00:00.000Z",
    _lastUpdated_: "2026-03-15T11:00:00.000Z",
    ...overrides,
  };
}

function makeCartRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `A#${ACCOUNT_ULID}`,
    SK: `${GUEST_ID_PREFIXED}${CART_ID_PREFIXED}`,
    customer_id: CUSTOMER_ID,
    email: "visitor@example.com",
    cart_items: [
      {
        name: "Walk Adventure 30 min",
        quantity: 1,
        price: 3000,
        total: 3000,
        variant_label: null,
        service_id: "S#01HXYZ3MNPQRSTVWXY3MNPQRSF",
        category: "walks",
        image_url: "",
        variant: null,
      },
      {
        name: "Dog Training Session",
        quantity: 2,
        price: 5000,
        total: 10000,
        variant_label: "60 min",
        service_id: "S#01HXYZ3MNPQRSTVWXY3MNPQRSG",
        category: "training",
        image_url: "",
        variant: "v1:opt1",
      },
    ],
    _createdAt_: "2026-03-15T10:30:00.000Z",
    _lastUpdated_: LAST_UPDATED,
    ...overrides,
  };
}

describe("CheckActiveCartTool", () => {
  let tool: CheckActiveCartTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckActiveCartTool,
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

    tool = module.get<CheckActiveCartTool>(CheckActiveCartTool);
  });

  describe("execute", () => {
    it("1 — happy path: returns has_cart: true with correct items, cart_total_cents, and last_updated_at", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeCurrentMetadata() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${PRIOR_SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makePriorMetadata() });

      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `${GUEST_ID_PREFIXED}${CART_ID_PREFIXED}` } })
        .resolves({ Item: makeCartRecord() });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.has_cart).toBe(true);
      expect(parsed.items).toHaveLength(2);

      // First item
      expect(parsed.items[0].name).toBe("Walk Adventure 30 min");
      expect(parsed.items[0].quantity).toBe(1);
      expect(parsed.items[0].price).toBe(3000);
      expect(parsed.items[0].total).toBe(3000);
      expect(parsed.items[0].variant_label).toBeNull();

      // Second item
      expect(parsed.items[1].name).toBe("Dog Training Session");
      expect(parsed.items[1].quantity).toBe(2);
      expect(parsed.items[1].price).toBe(5000);
      expect(parsed.items[1].total).toBe(10000);
      expect(parsed.items[1].variant_label).toBe("60 min");

      // Totals
      expect(parsed.cart_total_cents).toBe(13000); // 3000 + 10000
      expect(parsed.last_updated_at).toBe(LAST_UPDATED);
      expect(parsed.was_link_generated_at).toBeNull();
    });

    it("2 — missing customer_id: returns has_cart: false; no further GetItems issued beyond current METADATA", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeCurrentMetadata({ customer_id: undefined }) });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.has_cart).toBe(false);

      // Only the current session METADATA GetItem should have been called
      const getCalls = ddbMock.commandCalls(GetCommand);
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0].args[0].input.Key?.PK).toBe(`CHAT_SESSION#${SESSION_ULID}`);
    });

    it("3 — missing continuation_from_session_id: returns has_cart: false; no prior-session GetItem issued", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeCurrentMetadata({ continuation_from_session_id: undefined }) });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.has_cart).toBe(false);

      // Only one GetCommand (current session METADATA) — no prior-session call
      const getCalls = ddbMock.commandCalls(GetCommand);
      expect(getCalls).toHaveLength(1);
    });

    it("4 — prior METADATA missing cart_id: returns has_cart: false; no cart GetItem issued", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeCurrentMetadata() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${PRIOR_SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makePriorMetadata({ cart_id: undefined }) });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.has_cart).toBe(false);

      // Two GetCommands (current + prior METADATA) — no cart GetItem
      const getCalls = ddbMock.commandCalls(GetCommand);
      expect(getCalls).toHaveLength(2);
      const cartCall = getCalls.find((c) =>
        c.args[0].input.Key?.PK === `A#${ACCOUNT_ULID}`,
      );
      expect(cartCall).toBeUndefined();
    });

    it("5 — cart record missing: all upstream reads succeed; cart GetItem returns undefined; returns has_cart: false", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeCurrentMetadata() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${PRIOR_SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makePriorMetadata() });

      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `${GUEST_ID_PREFIXED}${CART_ID_PREFIXED}` } })
        .resolves({ Item: undefined });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.has_cart).toBe(false);
    });

    it("6 — legacy bare ULID normalization: prior METADATA has bare cart_id and guest_id; cart GetItem uses correctly prefixed SK", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeCurrentMetadata() });

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${PRIOR_SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makePriorMetadata({ cart_id: CART_ID_BARE, guest_id: GUEST_ID_BARE }) });

      // Expect cart GetItem with correctly prefixed SK
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `${GUEST_ID_PREFIXED}${CART_ID_PREFIXED}` } })
        .resolves({ Item: makeCartRecord() });

      const result = await tool.execute({}, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.has_cart).toBe(true);

      // Verify the cart GetItem was called with the prefixed SK
      const getCalls = ddbMock.commandCalls(GetCommand);
      const cartCall = getCalls.find((c) =>
        c.args[0].input.Key?.PK === `A#${ACCOUNT_ULID}`,
      );
      expect(cartCall).toBeDefined();
      expect(cartCall!.args[0].input.Key?.SK).toBe(`${GUEST_ID_PREFIXED}${CART_ID_PREFIXED}`);
    });

    it("7 — returns has_cart: false when accountUlid is missing from context", async () => {
      const contextWithoutAccount = { sessionUlid: SESSION_ULID, accountUlid: undefined } satisfies ChatToolExecutionContext;

      const result = await tool.execute({}, contextWithoutAccount);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.has_cart).toBe(false);

      // Guard exits before any DDB read
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });
  });
});
