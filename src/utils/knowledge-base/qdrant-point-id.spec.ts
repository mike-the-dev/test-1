import { generatePointId, KB_POINT_ID_NAMESPACE } from "./qdrant-point-id";

const UUID_V5_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generatePointId", () => {
  it("returns the same UUID for identical (accountId, documentId, chunkIndex) inputs", () => {
    const id1 = generatePointId("acct-A", "doc-1", 0);
    const id2 = generatePointId("acct-A", "doc-1", 0);
    expect(id1).toBe(id2);
  });

  it("returns different UUIDs for different accountId values", () => {
    const id1 = generatePointId("acct-A", "doc-1", 0);
    const id2 = generatePointId("acct-B", "doc-1", 0);
    expect(id1).not.toBe(id2);
  });

  it("returns different UUIDs for different documentId values", () => {
    const id1 = generatePointId("acct-A", "doc-1", 0);
    const id2 = generatePointId("acct-A", "doc-2", 0);
    expect(id1).not.toBe(id2);
  });

  it("returns different UUIDs for different chunkIndex values", () => {
    const id1 = generatePointId("acct-A", "doc-1", 0);
    const id2 = generatePointId("acct-A", "doc-1", 1);
    expect(id1).not.toBe(id2);
  });

  it("returns a valid UUIDv5 string", () => {
    const id = generatePointId("acct-A", "doc-1", 0);
    expect(id).toMatch(UUID_V5_REGEX);
  });

  it("KB_POINT_ID_NAMESPACE equals the committed hardcoded value (regression guard)", () => {
    expect(KB_POINT_ID_NAMESPACE).toBe("a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c");
  });
});
