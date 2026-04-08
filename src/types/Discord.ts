export interface RawGatewayPacket {
  t?: string;
  d?: {
    id?: string;
    channel_id?: string;
    guild_id?: string;
    content?: string;
    author?: {
      id?: string;
      bot?: boolean;
    };
  };
}
