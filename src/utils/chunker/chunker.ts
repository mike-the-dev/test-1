import { KnowledgeBaseChunk, KnowledgeBaseChunkOptions } from "../../types/KnowledgeBase";

export const DEFAULT_TARGET_CHARS = 2000;
export const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Searches for the rightmost natural boundary within the window [windowStart, windowEnd].
 * Returns the adjusted end position (advancing past the delimiter so it belongs to the
 * preceding chunk), or null if no boundary is found.
 *
 * Priority order: paragraph break (\n\n) > sentence boundary (. ! ?) > word boundary (space/newline).
 *
 * Note: character offsets are JavaScript code-unit indices. Multi-byte characters and emoji
 * produce correct (if potentially non-grapheme-aligned) offsets. Grapheme handling is out of scope.
 */
function findBoundary(
  source: string,
  windowStart: number,
  windowEnd: number,
): number | null {
  // Tier 1: paragraph break
  const paraIdx = source.lastIndexOf("\n\n", windowEnd);
  if (paraIdx >= windowStart) {
    return paraIdx + 2; // advance past \n\n so the delimiter stays with the preceding chunk
  }

  // Tier 2: sentence boundary
  // Returns the first delimiter type that has a match in the window, not the cross-type rightmost match.
  const sentenceDelimiters = [". ", "! ", "? ", ".\n", "!\n", "?\n"];
  for (const delimiter of sentenceDelimiters) {
    const idx = source.lastIndexOf(delimiter, windowEnd);
    if (idx >= windowStart) {
      return idx + delimiter.length; // advance past the full delimiter
    }
  }

  // Tier 3: word boundary (space or newline — excluded from both chunks by .trim())
  const spaceIdx = source.lastIndexOf(" ", windowEnd);
  if (spaceIdx >= windowStart) {
    return spaceIdx; // the space itself becomes the boundary; .trim() removes it
  }

  const newlineIdx = source.lastIndexOf("\n", windowEnd);
  if (newlineIdx >= windowStart) {
    return newlineIdx;
  }

  return null;
}

/**
 * Splits a source string into ordered, overlapping character-based chunks suitable for
 * embedding and vector storage.
 *
 * - Returns [] for empty or whitespace-only input.
 * - startOffset and endOffset are pre-trim window boundaries in the original source string.
 * - Prefers to break on paragraph breaks > sentence boundaries > word boundaries.
 * - Falls back to hard-cutting at targetChars when no boundary exists within the search window.
 */
export function chunkText(source: string, options?: KnowledgeBaseChunkOptions): KnowledgeBaseChunk[] {
  if (source.trim() === "") {
    return [];
  }

  const targetChars = options?.targetChars ?? DEFAULT_TARGET_CHARS;
  const overlapChars = options?.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  const chunks: KnowledgeBaseChunk[] = [];
  let position = 0;
  let index = 0;

  while (position < source.length) {
    let end = Math.min(position + targetChars, source.length);

    if (end < source.length) {
      const windowStart = position + Math.floor(targetChars * 0.75);
      const boundaryEnd = findBoundary(source, windowStart, end);
      if (boundaryEnd !== null) {
        end = boundaryEnd;
      }
    }

    const text = source.substring(position, end).trim();
    if (text !== "") {
      chunks.push({ text, index, startOffset: position, endOffset: end });
      index++;
    }

    if (end >= source.length) {
      break;
    }

    position = Math.max(end - overlapChars, position + 1);
  }

  return chunks;
}
