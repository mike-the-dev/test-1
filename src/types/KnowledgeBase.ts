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
// Ingestion endpoint types (Phase 4, updated Phase 7a)
// ---------------------------------------------------------------------------

/** The set of source document types accepted by the ingestion endpoint. */
export type KnowledgeBaseSourceType = "pdf" | "csv" | "docx" | "txt" | "html";

/** Validated request body passed from the controller to the ingestion service. */
export interface KnowledgeBaseIngestDocumentInput {
  /** Raw 26-character ULID (A# prefix already stripped by the controller). */
  accountId: string;
  externalId: string;
  title: string;
  text: string;
  sourceType: KnowledgeBaseSourceType;
  mimeType?: string;
}

/** Status state machine for KB documents (Phase 7c). */
export type KnowledgeBaseStatus = "pending" | "processing" | "ready" | "failed";

/** Response body returned on successful ingestion (201 Created — internal use; service still returns this). */
export interface KnowledgeBaseIngestDocumentResult {
  document_id: string;
  chunk_count: number;
  status: "ready";
  /** ISO-8601 timestamp set on create, preserved on update. */
  _createdAt_: string;
  /** ISO-8601 timestamp set on every create and every update. */
  _lastUpdated_: string;
}

/** 202 Accepted response from POST /knowledge-base/documents (Phase 7c). */
export interface KnowledgeBaseIngestAcceptedResult {
  document_id: string;
  status: "pending";
  _createdAt_: string;
}

/** 200 response from GET /knowledge-base/documents (Phase 7c). */
export interface KnowledgeBaseGetDocumentResult {
  document_id: string;
  account_id: string;
  external_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  mime_type?: string;
  /** Absent when status is "pending" or "processing". */
  chunk_count?: number;
  status: KnowledgeBaseStatus;
  _createdAt_: string;
  _lastUpdated_: string;
  /** Only present when status === "failed". */
  error_summary?: string;
}

/** Job payload enqueued by the POST controller for the BullMQ worker (Phase 7c). */
export interface KnowledgeBaseJobPayload {
  /** Raw 26-character ULID; A# prefix already stripped. */
  accountId: string;
  externalId: string;
  title: string;
  text: string;
  sourceType: KnowledgeBaseSourceType;
  mimeType?: string;
  /** Pre-generated or reused at POST time so the DDB record exists before the job runs. */
  documentId: string;
  /** ISO-8601; preserved from existing record on the update path. */
  createdAt: string;
}

/** DynamoDB record written for each ingested document. */
export interface KnowledgeBaseDocumentRecord {
  /** "A#<accountId>" */
  PK: string;
  /** "KB#DOC#<documentId>" */
  SK: string;
  entity: "KNOWLEDGE_BASE_DOCUMENT";
  document_id: string;
  account_id: string;
  external_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  mime_type?: string;
  /** Absent on pending/processing records; set when status transitions to ready. */
  chunk_count?: number;
  status: KnowledgeBaseStatus;
  /** ISO-8601; set on create, preserved on update. */
  _createdAt_: string;
  /** ISO-8601; set on every create and update. */
  _lastUpdated_: string;
  /** Short sanitized message; only present when status === "failed". */
  error_summary?: string;
}

/** Payload stored on each Qdrant point (one per chunk). */
export interface KnowledgeBasePointPayload {
  account_id: string;
  document_id: string;
  document_title: string;
  external_id: string;
  chunk_index: number;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
  source_type: KnowledgeBaseSourceType;
  /** ISO-8601 */
  _createdAt_: string;
  /** Claude-generated enrichment text (SUMMARY + QUESTIONS + KEY TERMS). Present only when enrichment succeeded for this chunk. */
  enrichment?: string;
}

// ---------------------------------------------------------------------------
// Delete endpoint types (Phase 7a)
// ---------------------------------------------------------------------------

/** Validated request body passed from the controller to the delete method. */
export interface KnowledgeBaseDeleteDocumentInput {
  /** Raw 26-character ULID (A# prefix already stripped by the controller). */
  accountId: string;
  externalId: string;
}

/** The delete method returns void (HTTP 204 No Content). */
export type KnowledgeBaseDeleteDocumentResult = void;

// ---------------------------------------------------------------------------
// Retrieval tool types (Phase 5, updated Phase 7a)
// ---------------------------------------------------------------------------

/**
 * A single matched chunk returned by the lookup_knowledge_base tool.
 * This is the agent-facing DTO — it maps from KnowledgeBasePointPayload,
 * renaming chunk_text → text for cleaner agent consumption.
 */
export interface KnowledgeBaseRetrievalChunk {
  /** The text content of the matched chunk. */
  text: string;
  /** Cosine similarity score from Qdrant. Higher is more similar. */
  score: number;
  /** Title of the source document this chunk was extracted from. */
  document_title: string;
  /** ID of the source document. */
  document_id: string;
  /** Zero-based position of this chunk within its source document. */
  chunk_index: number;
}

/** The JSON structure returned by the lookup_knowledge_base tool. */
export interface KnowledgeBaseRetrievalResult {
  chunks: KnowledgeBaseRetrievalChunk[];
  count: number;
}
