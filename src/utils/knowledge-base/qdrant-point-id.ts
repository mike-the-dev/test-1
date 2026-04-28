import { v5 as uuidv5 } from "uuid";

/**
 * Namespace UUID for KB Qdrant point IDs.
 *
 * DO NOT CHANGE — changing this value invalidates every deterministic point ID
 * ever generated. Existing Qdrant points would become orphaned because the update
 * flow's delete-by-document_id would no longer match their IDs. This is a
 * version-1 schema commitment, equivalent to a DynamoDB PK format.
 *
 * Generated once via crypto.randomUUID() on 2026-04-27.
 */
export const KB_POINT_ID_NAMESPACE = "a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c";

/**
 * Generates a deterministic Qdrant point ID from the (accountId, documentId, chunkIndex)
 * tuple. Same inputs always produce the same UUID; different inputs produce different UUIDs.
 * Per-account isolation is guaranteed: accountId is part of the input tuple, so two accounts
 * cannot produce colliding point IDs even for the same documentId and chunkIndex.
 */
export function generatePointId(
  accountId: string,
  documentId: string,
  chunkIndex: number,
): string {
  return uuidv5(`${accountId}:${documentId}:${chunkIndex}`, KB_POINT_ID_NAMESPACE);
}
