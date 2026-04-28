// MUST be first — Sentry requires initialization before any other module loads.
import "./instrument";

import { NestFactory } from "@nestjs/core";
import { Logger, LogLevel } from "@nestjs/common";

import { AppModule } from "./app.module";
import { OriginAllowlistService } from "./services/origin-allowlist.service";
import { VoyageDimGuardService } from "./services/voyage-dim-guard.service";

async function bootstrap() {
  const isProd = process.env.APP_ENV === "prod";
  const logLevels: LogLevel[] = isProd
    ? ["log", "warn", "error"]
    : ["log", "warn", "error", "debug", "verbose"];

  const app = await NestFactory.create(AppModule, { logger: logLevels });

  const dimGuard = app.get(VoyageDimGuardService);
  try {
    await dimGuard.checkDimension();
  } catch {
    process.exit(1);
  }

  const originAllowlistService = app.get(OriginAllowlistService);
  const corsAllowAll = process.env.WEB_CHAT_CORS_ALLOW_ALL === "true";

  // Trusted widget deployment origins (e.g. "https://chat.instapaytient.com",
  // "http://localhost:3000"). These bypass the GSI-based customer-practice
  // allowlist because the widget iframe's own origin is not a practice
  // domain — practice domains flow through the request body as hostDomain.
  const widgetOrigins = new Set(
    (process.env.WEB_CHAT_WIDGET_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  app.enableCors({
    origin: async (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        callback(null, !isProd);
        return;
      }

      if (corsAllowAll) {
        callback(null, true);
        return;
      }

      if (widgetOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      const accountUlid = await originAllowlistService.resolveAccountForOrigin(origin);
      callback(null, accountUlid !== null);
    },
  });

  const port = process.env.PORT ?? 3000;

  await app.listen(port);

  const logger = new Logger("Bootstrap");

  logger.log(`Application listening on port ${port}`);
}

bootstrap();
