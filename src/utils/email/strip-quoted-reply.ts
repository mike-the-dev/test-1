const GMAIL_QUOTE_PATTERN = /^On .+ wrote:$/m;
const OUTLOOK_ORIGINAL_MESSAGE_PATTERN = /^-----Original Message-----/m;
const QUOTED_LINE_PATTERN = /^>/m;
const OUTLOOK_FROM_PATTERN = /^From: .+$/m;
const SENT_OR_TO_LINE_PATTERN = /^(Sent:|To:)/m;
const OUTLOOK_FROM_LOOKAHEAD_LINE_COUNT = 3;

function findOutlookFromIndex(rawText: string): number {
  const fromMatch = OUTLOOK_FROM_PATTERN.exec(rawText);

  if (!fromMatch) {
    return -1;
  }

  const afterFrom = rawText.slice(fromMatch.index + fromMatch[0].length);
  const nextLines = afterFrom.split("\n").slice(0, OUTLOOK_FROM_LOOKAHEAD_LINE_COUNT).join("\n");

  if (!SENT_OR_TO_LINE_PATTERN.test(nextLines)) {
    return -1;
  }

  return fromMatch.index;
}

export function stripQuotedReply(rawText: string): string {
  const indices: number[] = [];

  const gmailMatch = GMAIL_QUOTE_PATTERN.exec(rawText);
  if (gmailMatch) {
    indices.push(gmailMatch.index);
  }

  const outlookMatch = OUTLOOK_ORIGINAL_MESSAGE_PATTERN.exec(rawText);
  if (outlookMatch) {
    indices.push(outlookMatch.index);
  }

  const quotedLineMatch = QUOTED_LINE_PATTERN.exec(rawText);
  if (quotedLineMatch) {
    indices.push(quotedLineMatch.index);
  }

  const outlookFromIndex = findOutlookFromIndex(rawText);
  if (outlookFromIndex >= 0) {
    indices.push(outlookFromIndex);
  }

  if (indices.length === 0) {
    return rawText.trim();
  }

  const cutIndex = Math.min(...indices);

  return rawText.slice(0, cutIndex).trim();
}
