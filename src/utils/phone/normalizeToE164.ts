import { parsePhoneNumberFromString, CountryCode } from "libphonenumber-js/min";

// Normalizes to E.164 so LLM-collected phones match Twilio-inbound keys in the customer GSI2 index.
export function normalizeToE164(input: string, defaultRegion: CountryCode = "US"): string | null {
  const trimmed = input.trim();
  const result = parsePhoneNumberFromString(trimmed, defaultRegion);

  if (result === undefined || !result.isValid()) {
    return null;
  }

  return result.format("E.164");
}
