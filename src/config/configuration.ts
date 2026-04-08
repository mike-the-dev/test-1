const configuration = () => ({
  app: {
    env: process.env.APP_ENV || "local",
    port: Number(process.env.PORT || 3000),
  },
  database: {
    region: process.env.DYNAMODB_REGION || "",
    endpoint:
      process.env.APP_ENV === "local" || !process.env.APP_ENV
        ? process.env.DYNAMODB_ENDPOINT || "http://localhost:8000"
        : process.env.DYNAMODB_ENDPOINT,
    conversationsTable: process.env.DYNAMODB_TABLE_CONVERSATIONS || "",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
  },
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN,
    guildId: process.env.DISCORD_GUILD_ID,
  },
});

export default configuration;
