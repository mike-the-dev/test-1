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
