import {
  chunkText,
  DEFAULT_TARGET_CHARS,
  DEFAULT_OVERLAP_CHARS,
} from "./chunker";

describe("chunkText", () => {
  it("returns an empty array for an empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns an empty array for a whitespace-only string", () => {
    expect(chunkText("   \n\n   \t  ")).toEqual([]);
  });

  it("returns a single chunk for a source shorter than DEFAULT_TARGET_CHARS", () => {
    const source = "Hello world. This is a short document.";
    const chunks = chunkText(source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks[0].endOffset).toBe(source.length);
    expect(chunks[0].text).toBe(source.trim());
  });

  it("returns a single chunk when source length equals DEFAULT_TARGET_CHARS", () => {
    const source = "a".repeat(DEFAULT_TARGET_CHARS);
    const chunks = chunkText(source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.length).toBe(DEFAULT_TARGET_CHARS);
  });

  it("breaks on paragraph boundaries when available", () => {
    const paragraph = "Word ".repeat(180).trim(); // ~900 chars
    const source = [paragraph, paragraph, paragraph, paragraph, paragraph].join(
      "\n\n",
    );
    const chunks = chunkText(source);
    expect(chunks.length).toBeGreaterThan(1);
    // At least one chunk ends cleanly at a paragraph break, not mid-word.
    // The text between chunk 0 and chunk 1 in the original source should contain \n\n.
    const gapStart = chunks[0].endOffset;
    const gapEnd = chunks[1].startOffset;
    const gap = source.substring(gapStart, gapEnd);
    expect(gap).toMatch(/\n\n/);
  });

  it("breaks on sentence boundaries when no paragraph breaks are present", () => {
    // Build ~5000 chars of text that uses '. ' but no \n\n.
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const source = sentence.repeat(Math.ceil(5000 / sentence.length));
    const chunks = chunkText(source);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk (except possibly the last) should end with a period+space or period
    // when we look at the raw source window, not mid-word.
    for (let i = 0; i < chunks.length - 1; i++) {
      const rawEnd = source.substring(
        chunks[i].endOffset - 2,
        chunks[i].endOffset,
      );
      expect(rawEnd).toMatch(/\.\s?$/);
    }
  });

  it("hard-cuts at targetChars when no natural boundaries exist", () => {
    const source = "a".repeat(5000);
    const chunks = chunkText(source);
    // All chunks except the last must be exactly DEFAULT_TARGET_CHARS in text length.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].text.length).toBe(DEFAULT_TARGET_CHARS);
    }
    // Last chunk text length <= DEFAULT_TARGET_CHARS.
    expect(chunks[chunks.length - 1].text.length).toBeLessThanOrEqual(
      DEFAULT_TARGET_CHARS,
    );
  });

  it("adjacent chunks overlap by approximately DEFAULT_OVERLAP_CHARS characters", () => {
    const source = "a".repeat(5000); // no boundaries, predictable hard cuts
    const chunks = chunkText(source);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      const current = chunks[i].text;
      const next = chunks[i + 1].text;
      // The last DEFAULT_OVERLAP_CHARS chars of current should appear at the start of next.
      const overlapSuffix = current.slice(-DEFAULT_OVERLAP_CHARS);
      expect(next.startsWith(overlapSuffix)).toBe(true);
    }
  });

  it("assigns sequential indices starting from 0", () => {
    const source = "a".repeat(5000);
    const chunks = chunkText(source);
    const indices = chunks.map((chunk) => chunk.index);
    expect(indices).toEqual(Array.from({ length: chunks.length }, (_ignored, chunkIndex) => chunkIndex));
  });

  it("respects custom targetChars and overlapChars", () => {
    const source = "Hello world. ".repeat(200); // ~2600 chars
    const chunks = chunkText(source, { targetChars: 500, overlapChars: 50 });
    // Allow small variance (~15%) for boundary alignment.
    const allowedMax = Math.ceil(500 * 1.15);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(allowedMax);
    }
    // Should produce more chunks than with default options.
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("terminates without infinite loop when overlapChars >= targetChars", () => {
    // This would loop forever without the position + 1 floor.
    const chunks = chunkText("a".repeat(10000), {
      targetChars: 100,
      overlapChars: 200,
    });
    // Just assert it ran and returned something.
    expect(chunks.length).toBeGreaterThan(0);
  });
});
