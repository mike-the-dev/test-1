import { NestFactory } from "@nestjs/core";
import { Logger, LogLevel } from "@nestjs/common";

import { AppModule } from "./app.module";
import { OriginAllowlistService } from "./services/origin-allowlist.service";

async function bootstrap() {
  const isProd = process.env.APP_ENV === "prod";
  const logLevels: LogLevel[] = isProd
    ? ["log", "warn", "error"]
    : ["log", "warn", "error", "debug", "verbose"];

  const app = await NestFactory.create(AppModule, { logger: logLevels });

  const originAllowlistService = app.get(OriginAllowlistService);
  const corsAllowAll = process.env.WEB_CHAT_CORS_ALLOW_ALL === "true";

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

      const allowed = await originAllowlistService.isAllowed(origin);
      callback(null, allowed);
    },
  });

  const port = process.env.PORT ?? 3000;

  await app.listen(port);

  const logger = new Logger("Bootstrap");

  logger.log(`Application listening on port ${port}`);
}

bootstrap();
