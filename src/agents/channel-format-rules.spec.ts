import { getChannelFormatRules } from "./channel-format-rules";

describe("getChannelFormatRules", () => {
  // ---------------------------------------------------------------------------
  // Email channel
  // ---------------------------------------------------------------------------

  describe("email channel", () => {
    it("returns text that identifies the email channel", () => {
      const result = getChannelFormatRules("email", null);
      expect(result).toContain("replying via the email channel");
    });

    it("includes the fromName in the signoff when fromName is provided", () => {
      const result = getChannelFormatRules("email", "Pawsome Walks");
      expect(result).toContain("Pawsome Walks team");
    });

    it("falls back to 'The team' signoff when fromName is null", () => {
      const result = getChannelFormatRules("email", null);
      expect(result).toContain("The team");
      expect(result).not.toContain("null");
    });

    it("falls back to 'The team' signoff when fromName is an empty string", () => {
      const result = getChannelFormatRules("email", "");
      expect(result).toContain("The team");
    });

    it("falls back to 'The team' signoff when fromName is whitespace only", () => {
      const result = getChannelFormatRules("email", "   ");
      expect(result).toContain("The team");
    });

    it("includes instructions about plain prose and no markdown", () => {
      const result = getChannelFormatRules("email", null);
      expect(result).toContain("Plain prose only");
      expect(result).toContain("No **bold**");
    });

    it("ends with the indented signoff when fromName is provided", () => {
      const result = getChannelFormatRules("email", "Rejuvé Med Spa");
      expect(result.trimEnd().endsWith("Best,\n   Rejuvé Med Spa team")).toBe(true);
    });

    it("ends with the indented fallback signoff when fromName is null", () => {
      const result = getChannelFormatRules("email", null);
      expect(result.trimEnd().endsWith("Best,\n   The team")).toBe(true);
    });

    it("includes banned-content vocabulary in the rules", () => {
      const result = getChannelFormatRules("email", null);
      expect(result).toContain("em-dash");
      expect(result).toContain("bullet");
      expect(result).toContain("asterisks");
      expect(result).toContain("**bold**");
    });

    it("includes the greeting instruction", () => {
      const result = getChannelFormatRules("email", null);
      expect(result).toContain("Greeting");
    });
  });

  // ---------------------------------------------------------------------------
  // SMS channel
  // ---------------------------------------------------------------------------

  describe("sms channel", () => {
    it("returns text that identifies the SMS channel", () => {
      const result = getChannelFormatRules("sms", null);
      expect(result).toContain("replying via the SMS channel");
    });

    it("mentions the 320 character aim", () => {
      const result = getChannelFormatRules("sms", null);
      expect(result).toContain("320 characters");
    });

    it("ignores the fromName argument", () => {
      const withName = getChannelFormatRules("sms", "Some Practice");
      const withNull = getChannelFormatRules("sms", null);
      expect(withName).toBe(withNull);
    });
  });

  // ---------------------------------------------------------------------------
  // Web channel
  // ---------------------------------------------------------------------------

  describe("web channel", () => {
    it("returns text that identifies the web chat channel", () => {
      const result = getChannelFormatRules("web", null);
      expect(result).toContain("replying via the web chat channel");
    });

    it("mentions that markdown is allowed", () => {
      const result = getChannelFormatRules("web", null);
      expect(result).toContain("Markdown formatting");
    });

    it("ignores the fromName argument", () => {
      const withName = getChannelFormatRules("web", "Some Practice");
      const withNull = getChannelFormatRules("web", null);
      expect(withName).toBe(withNull);
    });
  });
});
