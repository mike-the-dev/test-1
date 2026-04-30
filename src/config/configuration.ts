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
  voyage: {
    apiKey: process.env.VOYAGE_API_KEY,
    model: process.env.VOYAGE_MODEL || "voyage-3-large",
  },
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY || "",
    fromEmail: process.env.SENDGRID_FROM_EMAIL || "",
    fromName: process.env.SENDGRID_FROM_NAME || "",
    replyDomain: process.env.SENDGRID_REPLY_DOMAIN || "",
    replyAccountId: process.env.SENDGRID_REPLY_ACCOUNT_ID || "",
  },
  webChat: {
    corsAllowAll: process.env.WEB_CHAT_CORS_ALLOW_ALL === "true",
    domainGsiName: process.env.DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME || "GSI1",
    checkoutBaseUrlOverride: process.env.CHECKOUT_BASE_URL_OVERRIDE,
    widgetOrigins: (process.env.WEB_CHAT_WIDGET_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  },
  qdrant: {
    url: process.env.QDRANT_URL || "",
    apiKey: process.env.QDRANT_API_KEY,
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
  },
  sentry: {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? "local",
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  },
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
  },
  internalApiAuth: {
    key: process.env.KB_INTERNAL_API_KEY,
  },
});

export default configuration;
