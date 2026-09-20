// Manual testing:
//   npm run old-freshness -- --build-index                (build freshness-state-old.json)
//   npm run old-freshness -- --run [--limit N] [--dry-run]  (run one interval+cap pass)
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { OldPostsFreshnessService } from "./freshness/old-posts-freshness.service";

async function run() {
  const flags = process.argv.slice(2);
  process.env.DISABLE_CRONS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const oldFreshness = app.get(OldPostsFreshnessService);

  if (flags.includes("--build-index")) {
    const result = await oldFreshness.buildIndex();
    console.log(JSON.stringify(result, null, 2));
    await app.close();
    return;
  }

  if (flags.includes("--run")) {
    const limitIdx = flags.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : 250;
    const dryRun = flags.includes("--dry-run");
    const result = await oldFreshness.runPass(limit, dryRun);
    console.log(JSON.stringify(result, null, 2));
    await app.close();
    return;
  }

  console.error(
    "Usage: npm run old-freshness -- --build-index\n" +
      "   or: npm run old-freshness -- --run [--limit N] [--dry-run]",
  );
  process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
