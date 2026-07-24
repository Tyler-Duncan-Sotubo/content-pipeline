// One-shot audit run: npm run audit
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { AuditService } from "./audit/audit.service";

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const audit = app.get(AuditService);
  const summary = await audit.runAudit();
  console.log(JSON.stringify(summary, null, 2));
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
