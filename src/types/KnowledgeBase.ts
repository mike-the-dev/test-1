/** A single chunk produced by chunkText(). */
export interface KnowledgeBaseChunk {
  /** The trimmed text content of this chunk. */
  text: string;
  /** Zero-based position of this chunk in the ordered sequence. */
  index: number;
  /** Character offset in the original source where this chunk begins (before trim). */
  startOffset: number;
  /** Character offset in the original source where this chunk ends (before trim). */
  endOffset: number;
}

/** Options for chunkText(). All fields are optional; defaults are applied inside the function. */
export interface KnowledgeBaseChunkOptions {
  /** Target chunk size in characters. Defaults to DEFAULT_TARGET_CHARS. */
  targetChars?: number;
  /** Number of characters to overlap between adjacent chunks. Defaults to DEFAULT_OVERLAP_CHARS. */
  overlapChars?: number;
}

// ---------------------------------------------------------------------------
// Ingestion endpoint types (Phase 4)
// ---------------------------------------------------------------------------

/** The set of source document types accepted by the ingestion endpoint. */
export type KnowledgeBaseSourceType = "pdf" | "csv" | "docx" | "txt" | "html";

/** Validated request body passed from the controller to the ingestion service. */
export interface IngestDocumentInput {
  /** Raw 26-character ULID (A# prefix already stripped by the controller). */
  accountUlid: string;
  externalId: string;
  title: string;
  text: string;
  sourceType: KnowledgeBaseSourceType;
  mimeType?: string;
}

/** Response body returned on successful ingestion (201 Created). */
export interface IngestDocumentResult {
  documentUlid: string;
  chunkCount: number;
  status: "ready";
  /** ISO-8601 timestamp captured at the start of the ingestion pipeline. */
  createdAt: string;
}

/** DynamoDB record written for each ingested document. */
export interface KnowledgeBaseDocumentRecord {
  /** "A#<accountUlid>" */
  pk: string;
  /** "KB#DOC#<documentUlid>" */
  sk: string;
  entity: "KB_DOCUMENT";
  document_ulid: string;
  account_ulid: string;
  external_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  mime_type?: string;
  chunk_count: number;
  status: "ready";
  /** ISO-8601 */
  created_at: string;
}

/** Payload stored on each Qdrant point (one per chunk). */
export interface KnowledgeBasePointPayload {
  account_ulid: string;
  document_ulid: string;
  document_title: string;
  external_id: string;
  chunk_index: number;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
  source_type: KnowledgeBaseSourceType;
  /** ISO-8601 */
  created_at: string;
}
