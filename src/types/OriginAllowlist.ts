export interface OriginAllowlistCacheEntry {
  accountUlid: string | null;
  expiresAt: number;
}

export interface EmbedAuthorizationCacheEntry {
  authorized: boolean;
  expiresAt: number;
}
