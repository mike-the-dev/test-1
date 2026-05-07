import { Entity } from "./EntityEnum";

export enum ChannelAddressType {
  EMAIL_REPLY_DOMAIN = "email_reply_domain",
  TWILIO_NUMBER = "twilio_number",
}

export interface AccountEmailChannelConfig {
  reply_domains: string[];
  reply_local_part: string;
  from_name: string;
}

export interface AccountSmsChannelConfig {
  phone_numbers: string[];
}

export interface AccountChannelsConfig {
  email?: AccountEmailChannelConfig;
  sms?: AccountSmsChannelConfig;
}

export interface AccountChannelAddressRecord {
  PK: string; // "A#<accountId>"
  SK: string; // "<CHANNEL_TYPE>#<address>"
  entity: Entity.ACCOUNT_CHANNEL_ADDRESS;
  channel_type: string;
  address: string;
  "GSI1-PK": string; // "<CHANNEL_TYPE>#<address>"
  "GSI1-SK": string; // "ACCOUNT#<accountId>"
  _createdAt_: string;
  _lastUpdated_: string;
}

export interface AccountChannelArrayKeys {
  channelKey: string;
  addressArrayKey: string;
}

export type AccountChannelProvisionResult = { provisioned: true } | { error: string };

export type AccountChannelDeprovisionResult = { deprovisioned: true } | { error: string };

/** Extra properties the DynamoDB SDK appends to TransactionCanceledException instances. */
export type AccountChannelTransactionCanceledError = Error & {
  CancellationReasons?: { Code?: string }[];
};
