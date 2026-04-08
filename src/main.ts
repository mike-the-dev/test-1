import { NestFactory } from "@nestjs/core";
import { Logger, LogLevel } from "@nestjs/common";

import { AppModule } from "./app.module";

async function bootstrap() {
  const isProd = process.env.APP_ENV === "prod";
  const logLevels: LogLevel[] = isProd
    ? ["log", "warn", "error"]
    : ["log", "warn", "error", "debug", "verbose"];

  const app = await NestFactory.create(AppModule, { logger: logLevels });

  const port = process.env.PORT ?? 3000;

  await app.listen(port);

  const logger = new Logger("Bootstrap");

  logger.log(`Application listening on port ${port}`);
}

bootstrap();
