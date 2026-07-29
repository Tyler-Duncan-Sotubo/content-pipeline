// Manual testing:
//   npm run freshness -- --build-index               (rebuild freshness-state.json)
//   npm run freshness -- --add-posts 123,456,789      (manually add specific post IDs to rotation)
//   npm run freshness -- [--limit N] [--dry-run]      (run a refresh pass)
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { FreshnessService } from "./freshness/freshness.service";

async function run() {
  const flags = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const freshness = app.get(FreshnessService);

  if (flags.includes("--build-index")) {
    const result = await freshness.buildIndex();
    console.log(JSON.stringify(result, null, 2));
    await app.close();
    return;
  }

  const addPostsIdx = flags.indexOf("--add-posts");
  if (addPostsIdx >= 0) {
    const idsArg = flags[addPostsIdx + 1] ?? "";
    const postIds = idsArg
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (postIds.length === 0) {
      console.error("Usage: npm run freshness -- --add-posts 123,456,789");
      process.exit(1);
    }
    const result = await freshness.addPosts(postIds);
    console.log(JSON.stringify(result, null, 2));
    await app.close();
    return;
  }

  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : 150;
  const dryRun = flags.includes("--dry-run");
  const result = await freshness.runPass(limit, dryRun);
  console.log(JSON.stringify(result, null, 2));
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
