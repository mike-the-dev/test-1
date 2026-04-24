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
export interface KnowledgeBaseIngestDocumentInput {
  /** Raw 26-character ULID (A# prefix already stripped by the controller). */
  accountUlid: string;
  externalId: string;
  title: string;
  text: string;
  sourceType: KnowledgeBaseSourceType;
  mimeType?: string;
}

/** Response body returned on successful ingestion (201 Created). */
export interface KnowledgeBaseIngestDocumentResult {
  documentUlid: string;
  chunkCount: number;
  status: "ready";
  /** ISO-8601 timestamp captured at the start of the ingestion pipeline. */
  createdAt: string;
}

/** DynamoDB record written for each ingested document. */
export interface KnowledgeBaseDocumentRecord {
  /** "A#<accountUlid>" */
  PK: string;
  /** "KB#DOC#<documentUlid>" */
  SK: string;
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

// ---------------------------------------------------------------------------
// Retrieval tool types (Phase 5)
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
  /** ULID of the source document. */
  document_ulid: string;
  /** Zero-based position of this chunk within its source document. */
  chunk_index: number;
}

/** The JSON structure returned by the lookup_knowledge_base tool. */
export interface KnowledgeBaseRetrievalResult {
  chunks: KnowledgeBaseRetrievalChunk[];
  count: number;
}
