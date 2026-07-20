import { Module } from "@nestjs/common";
import { LoggerModule as PinoLoggerModule } from "nestjs-pino";
import pino from "pino";

const isProd = process.env.NODE_ENV === "production";
const logtailToken = process.env.LOGTAIL_SOURCE_TOKEN;
const ingest = process.env.LOGTAIL_INGEST_HOST; // e.g. s123.eu-nbg-2.betterstackdata.com

/**
 * Pino logging with a Better Stack (Logtail) target in production. No HTTP
 * middleware here (pinoHttp) since this is a CLI/cron worker, not a server -
 * just a plain Pino instance NestJS logs through.
 */
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
        timestamp: pino.stdTimeFunctions.isoTime,
        messageKey: "message",

        // add global props to every line
        base: {
          service: process.env.APP_NAME || "content-pipeline",
          env: process.env.NODE_ENV || "development",
        },

        // keep secrets out, just in case anything ever logs a raw object
        redact: {
          paths: ["apiKey", "password", "appPassword", "token"],
          remove: true,
        },

        // multi-target transports: pretty console (dev) + Better Stack (prod)
        transport: {
          targets: [
            ...(!isProd
              ? [
                  {
                    target: "pino-pretty",
                    level: process.env.LOG_LEVEL || "debug",
                    options: {
                      singleLine: true,
                      colorize: true,
                      translateTime: "SYS:standard",
                    },
                  } as const,
                ]
              : []),
            ...(logtailToken && ingest
              ? [
                  {
                    target: "@logtail/pino",
                    level: process.env.LOGTAIL_LEVEL || "warn",
                    options: {
                      sourceToken: logtailToken,
                      options: { endpoint: `https://${ingest}` },
                    },
                  } as const,
                ]
              : []),
          ],
        },
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
