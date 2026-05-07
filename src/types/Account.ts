import { Entity } from "./EntityEnum";
import { AccountChannelsConfig } from "./AccountChannel";

/**
 * DynamoDB account record. Mirrors the source-of-truth `AccountDynamo` interface
 * in the e-commerce backend (`ecommerce-app-backend-prod/src/types/Account.ts`).
 * Local additions only: `channels` (per-account email/SMS routing config) and
 * `allowed_embed_origins` (web-chat widget allowlist), both of which are
 * specific to this conversational API and not consumed by the e-commerce app.
 *
 * Keep this in sync with the e-commerce side when the source-of-truth changes.
 */
export interface AccountStatusDynamo {
  is_active: boolean;
  code: string;
  message: string;
  updated_at: string;
}

export interface AccountAnalyticsTargets {
  avg_spent_cents: number;
  subscription_rate_percent: number;
  repeat_rate_percent: number;
  retention_rate_percent: number;
}

export interface AccountPayout {
  name: string;
  currency: string;
  stripe_id: string;
  take: number;
  take_affirm?: number;
  total_payout_amount: number;
  instant_payout_enabled: boolean;
}

export interface AccountDynamo {
  PK: string;
  SK: string;
  name: string;
  company: string;
  state: string;
  "GSI1-PK": string;
  "GSI1-SK": string;
  entity: Entity.ACCOUNT;
  vercel_project_id?: string;
  payout?: AccountPayout;
  analytics_targets?: AccountAnalyticsTargets;
  status?: AccountStatusDynamo;
  // Local additions (this codebase only — not present on the e-commerce side):
  channels?: AccountChannelsConfig;
  allowed_embed_origins?: string[];
  _lastUpdated_: string;
  _createdAt_: string;
}
