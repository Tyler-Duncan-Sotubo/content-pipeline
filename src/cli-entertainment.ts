// Manual testing:
//   npm run entertainment -- --dry-run [--limit N]
//   npm run entertainment -- [--limit N]
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { EntertainmentService } from "./entertainment/entertainment.service";

async function run() {
  const flags = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : 3;

  process.env.DISABLE_CRONS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const result = await app.get(EntertainmentService).runOnce(limit, dryRun);
  console.log(JSON.stringify(result, null, 2));
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
