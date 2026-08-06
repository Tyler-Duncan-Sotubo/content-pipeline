// One-off: dedupe Advanced Ads blocks on posts touched by the
// remove-release-date.ts run before it had the strip-baked-ads fix.
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";
import { stripBakedAds } from "./strip-baked-ads";

const CATEGORY_SLUGS = [
  "download-mp3",
  "south-africa",
  "congo",
  "kenya",
  "lyrics",
  "tanzania",
  "ghana-music",
  "zambia",
  "united-kingdom",
];

// Counts each distinct placement TYPE separately (before-content,
// after-content, atf-banner, or any other) - a post is only "duplicated" if
// any single type appears more than once, not by raw total count (a post
// can legitimately have several different placement types, one each).
function countAdsByType(content: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const matches = content.matchAll(/class="tooxc-([a-z-]+) tooxc-entity-placement/g);
  for (const m of matches) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

function hasDuplicates(counts: Record<string, number>): boolean {
  return Object.values(counts).some((c) => c > 1);
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  process.env.DISABLE_CRONS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const wordpress = app.get(WordpressService);

  let seen = 0;
  let fixed = 0;
  let failed = 0;

  for (const slug of CATEGORY_SLUGS) {
    const categoryId = await wordpress.resolveCategoryIdBySlug(slug);
    if (!categoryId) continue;

    let page = 1;
    for (;;) {
      let posts;
      try {
        posts = await wordpress.listPostsByCategoryNewestFirst(categoryId, page, 100);
      } catch (err) {
        if ((err as Error).message.includes("400")) break;
        throw err;
      }
      if (posts.length === 0) break;

      for (const post of posts) {
        seen++;
        const content = post.content.rendered;
        const counts = countAdsByType(content);
        if (!hasDuplicates(counts)) continue;

        // Any placement type appearing more than once means duplication -
        // strip all and let Advanced Ads' save hook re-add exactly one of
        // each on the next real save. stripBakedAds removes ALL matches,
        // bringing it to 0; Advanced Ads then re-adds on save, same as the
        // other fixes.
        const { content: stripped, removed } = stripBakedAds(content);
        console.log(
          `[${dryRun ? "dry-run" : "fix"}] Post ${post.id} (${post.link}): had ${JSON.stringify(counts)} (${removed} removed)`,
        );
        if (!dryRun) {
          try {
            await wordpress.patchPost(post.id, { content: stripped });
            fixed++;
          } catch (err) {
            failed++;
            console.warn(`  FAILED: ${(err as Error).message}`);
          }
        } else {
          fixed++;
        }
      }
      page++;
    }
  }

  console.log(`\nDone. Seen ${seen}, fixed ${fixed}, failed ${failed}.` + (dryRun ? " [DRY RUN]" : ""));
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
