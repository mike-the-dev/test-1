import { normalizeToE164 } from "./normalizeToE164";

describe("normalizeToE164", () => {
  it("normalizes a raw 10-digit US number to E.164", () => {
    expect(normalizeToE164("4155551234")).toBe("+14155551234");
  });

  it("normalizes a pretty-formatted US number to E.164", () => {
    expect(normalizeToE164("(415) 555-1234")).toBe("+14155551234");
  });

  it("passes through an already-E.164 number unchanged", () => {
    expect(normalizeToE164("+14155551234")).toBe("+14155551234");
  });

  it("trims leading and trailing whitespace before parsing", () => {
    expect(normalizeToE164("  +14155551234  ")).toBe("+14155551234");
  });

  it("returns null for an unparseable string", () => {
    expect(normalizeToE164("not-a-phone")).toBeNull();
  });

  it("returns null for a 7-digit US number without an area code", () => {
    expect(normalizeToE164("555-0100")).toBeNull();
  });

  it("passes through an international E.164 number unchanged", () => {
    expect(normalizeToE164("+33612345678")).toBe("+33612345678");
  });
});
