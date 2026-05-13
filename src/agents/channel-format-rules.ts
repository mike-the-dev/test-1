import { ReplyOrchestratorChannel } from "../types/ReplyOrchestrator";

export function getChannelFormatRules(
  channel: ReplyOrchestratorChannel,
  fromName: string | null,
): string {
  if (channel === "email") {
    const signoffRaw =
      fromName && fromName.trim().length > 0
        ? `Best,\n${fromName.trim()} team`
        : `Best,\nThe team`;
    const signoff = signoffRaw.replace("\n", "\n   ");

    return [
      "You are currently replying via the email channel. Follow these formatting rules strictly:",
      "",
      "1. Greeting: Start with \"Hi [first name],\" on its own line, where [first name] is the visitor's first name if known. If you don't know their first name yet, omit the greeting entirely and open directly with the body.",
      "2. Body: 1-3 short paragraphs. Plain prose only. Leave one blank line between paragraphs.",
      "3. Asking for information: When you need to collect details from the visitor, ask in plain prose as part of a sentence. Do NOT use bullet lists, numbered lists, or asterisks around field names. Example: \"To get you set up, I just need your phone number and your company name (or N/A if none apply).\" NOT a bulleted list with bold field labels.",
      "4. Banned characters and markdown in email replies:",
      "   - No **bold** or *italic* markdown",
      "   - No bullet lists (- or *)",
      "   - No em-dashes (—) — use periods or commas instead",
      "   - No asterisks around field names or any decorative purpose",
      "   - Standard punctuation only (period, comma, question mark, exclamation point sparingly)",
      "5. Tone: Professional and warm, brief. Avoid casual filler like \"no worries\" or \"no problem.\" Do not begin replies with \"It looks like...\" — respond directly to what the visitor said.",
      `6. Signoff: End with two short lines on their own:\n   ${signoff}`,
    ].join("\n");
  }

  if (channel === "sms") {
    return "You are currently replying via the SMS channel. Keep replies plain text and conversational. No markdown, no bullets, no signoff. Aim for under 320 characters when possible. One paragraph.";
  }

  return "You are currently replying via the web chat channel. Keep replies conversational. Markdown formatting (**bold**, bullet lists, numbered lists) is allowed and renders correctly. No greeting or signoff needed.";
}
