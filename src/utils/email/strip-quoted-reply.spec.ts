import { stripQuotedReply } from "./strip-quoted-reply";

describe("stripQuotedReply", () => {
  it("strips a Gmail-style reply marker", () => {
    const input = [
      "Thanks for the info!",
      "",
      "On Mon, Apr 7 2026 at 12:00 PM, Bob Smith <bob@example.com> wrote:",
      "> Some quoted text here",
    ].join("\n");

    const result = stripQuotedReply(input);

    expect(result).toBe("Thanks for the info!");
  });

  it("strips an Outlook desktop original message marker", () => {
    const input = [
      "My reply here.",
      "",
      "-----Original Message-----",
      "From: alice@example.com",
      "Subject: Hello",
    ].join("\n");

    const result = stripQuotedReply(input);

    expect(result).toBe("My reply here.");
  });

  it("strips at the first > quoted line", () => {
    const input = [
      "Here is my response.",
      "",
      "> Original quoted content",
      "> More quoted content",
    ].join("\n");

    const result = stripQuotedReply(input);

    expect(result).toBe("Here is my response.");
  });

  it("returns the original text trimmed when no quote marker is found", () => {
    const input = "  Just a plain message with no quoting.  ";

    const result = stripQuotedReply(input);

    expect(result).toBe("Just a plain message with no quoting.");
  });

  it("returns an empty string for empty input", () => {
    const result = stripQuotedReply("");

    expect(result).toBe("");
  });

  it("strips at an Outlook From: line followed by Sent: within 3 lines", () => {
    const input = [
      "My new message.",
      "",
      "From: alice@example.com",
      "Sent: Monday, April 7 2026 12:00 PM",
      "To: bob@example.com",
      "Subject: Hello",
      "",
      "Previous message content",
    ].join("\n");

    const result = stripQuotedReply(input);

    expect(result).toBe("My new message.");
  });
});
