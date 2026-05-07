/**
 * Single-table DynamoDB entity discriminator. The string values intentionally
 * match the source-of-truth `Entity` enum in the e-commerce backend so records
 * remain interpretable across both applications. Only entities actually used by
 * this codebase are listed here — additional entities can be added as needed
 * (do not mirror the full e-commerce list wholesale).
 */
export enum Entity {
  ACCOUNT = "ACCOUNT",
  ACCOUNT_CHANNEL_ADDRESS = "ACCOUNT_CHANNEL_ADDRESS",
  CUSTOMER = "CUSTOMER",
  CHAT_SESSION = "CHAT_SESSION",
  ATTRIBUTION = "ATTRIBUTION",
  ATTRIBUTION_POINTER = "ATTRIBUTION_POINTER",
  VERIFICATION_CODE = "VERIFICATION_CODE",
  KNOWLEDGE_BASE_DOCUMENT = "KNOWLEDGE_BASE_DOCUMENT",
}
