import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const logger = app.get(Logger);

  // Last-resort safety net. This is a long-running cron host: a single
  // stray rejection anywhere (a network blip inside a callback, a library
  // that rejects out-of-band) would otherwise kill the process and take
  // every scheduled job down with it. Confirmed live: unhandled
  // ECONNRESETs on Sept 1 2026 crashed the app and both freshness
  // rotations stopped for days before anyone noticed. Logging and staying
  // up is strictly better here than dying - a missed post is recoverable,
  // a dead scheduler is not.
  process.on("unhandledRejection", (reason) => {
    logger.error(
      `Unhandled promise rejection (process kept alive): ${
        reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
      }`,
    );
  });

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception (process kept alive): ${err.message}\n${err.stack}`);
  });

  const port = process.env.PORT ?? 8000;
  await app.listen(port);
  logger.log(`Content pipeline listening on http://localhost:${port}`);
}
bootstrap();
