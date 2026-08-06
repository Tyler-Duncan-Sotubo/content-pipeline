// Manual testing:
//   npm run old-freshness -- --build-index                    (build freshness-state-old.json)
//   npm run old-freshness -- --distribution                   (show bucket counts)
//   npm run old-freshness -- --bucket N [--limit N] [--dry-run]  (run a specific bucket's pass)
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

  if (flags.includes("--distribution")) {
    const result = oldFreshness.getBucketDistribution();
    console.log(JSON.stringify(result, null, 2));
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    console.log(`Total: ${total}`);
    await app.close();
    return;
  }

  const bucketIdx = flags.indexOf("--bucket");
  if (bucketIdx < 0) {
    console.error(
      "Usage: npm run old-freshness -- --build-index\n" +
        "   or: npm run old-freshness -- --distribution\n" +
        "   or: npm run old-freshness -- --bucket N [--limit N] [--dry-run]",
    );
    process.exit(1);
  }

  const bucket = Number(flags[bucketIdx + 1]);
  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : 220;
  const dryRun = flags.includes("--dry-run");

  const result = await oldFreshness.runBucket(bucket, limit, dryRun);
  console.log(JSON.stringify(result, null, 2));
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
