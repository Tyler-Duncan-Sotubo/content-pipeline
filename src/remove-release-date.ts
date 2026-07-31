/**
 * Removes the static "Release Date: {date}" line from existing posts'
 * metadata blocks - see strip-release-date.ts for why. New articles no
 * longer generate this line (article.prompt.ts was updated); this cleans up
 * posts published before that change.
 *
 * Usage:
 *   npm run remove-release-date -- --freshness-only [--dry-run] [--limit N]
 *     Only checks posts already in freshness-state.json.
 *   npm run remove-release-date -- <category-slug|all> [--dry-run] [--limit N]
 *     Broader scan across a whole category (or all 9 the freshness system
 *     manages).
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";
import { stripReleaseDate } from "./strip-release-date";
import { stripBakedAds } from "./strip-baked-ads";

// Advanced Ads' save hook re-inserts its "Before Content"/"After Content" ad
// block on every post save with no duplicate-check (confirmed live -
// FreshnessService hit the same issue). Any save this script makes must
// strip existing ad blocks first, so Advanced Ads' hook adds back exactly
// one clean copy instead of duplicating whatever was already there.
function prepareForSave(content: string): string {
  return stripBakedAds(content).content;
}

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

async function processPostIds(
  postIds: number[],
  wordpress: WordpressService,
  dryRun: boolean,
  limit: number,
): Promise<{ seen: number; cleaned: number; failed: number }> {
  let seen = 0;
  let cleaned = 0;
  let failed = 0;

  for (const postId of postIds) {
    if (cleaned >= limit) break;
    seen++;

    let post;
    try {
      post = await wordpress.getPostContent(postId);
    } catch (err) {
      failed++;
      console.warn(`Could not fetch post ${postId}: ${(err as Error).message}`);
      continue;
    }

    const { content, removed } = stripReleaseDate(post.content);
    if (removed === 0) continue;

    cleaned++;
    console.log(`[${dryRun ? "dry-run" : "clean"}] Post ${postId} (${post.link}): removed Release Date line`);

    if (!dryRun) {
      try {
        await wordpress.patchPost(postId, { content: prepareForSave(content) });
      } catch (err) {
        failed++;
        console.warn(`  FAILED to save post ${postId}: ${(err as Error).message}`);
      }
    }
  }

  return { seen, cleaned, failed };
}

async function processCategories(
  slugs: string[],
  wordpress: WordpressService,
  dryRun: boolean,
  limit: number,
): Promise<{ seen: number; cleaned: number; failed: number }> {
  let seen = 0;
  let cleaned = 0;
  let failed = 0;

  for (const slug of slugs) {
    const categoryId = await wordpress.resolveCategoryIdBySlug(slug);
    if (!categoryId) {
      console.warn(`Could not resolve category slug "${slug}" - skipping`);
      continue;
    }

    let page = 1;
    for (;;) {
      if (cleaned >= limit) break;
      let posts;
      try {
        posts = await wordpress.listPostsByCategoryNewestFirst(categoryId, page, 100);
      } catch (err) {
        if ((err as Error).message.includes("400")) break;
        throw err;
      }
      if (posts.length === 0) break;

      for (const post of posts) {
        if (cleaned >= limit) break;
        seen++;

        const { content, removed } = stripReleaseDate(post.content.rendered);
        if (removed === 0) continue;

        cleaned++;
        console.log(`[${dryRun ? "dry-run" : "clean"}] Post ${post.id} (${post.link}): removed Release Date line`);

        if (!dryRun) {
          try {
            await wordpress.patchPost(post.id, { content: prepareForSave(content) });
          } catch (err) {
            failed++;
            console.warn(`  FAILED to save post ${post.id}: ${(err as Error).message}`);
          }
        }
      }
      page++;
    }
  }

  return { seen, cleaned, failed };
}

async function run() {
  const [, , categoryArg, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");
  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : Infinity;
  const freshnessOnly = categoryArg === "--freshness-only" || flags.includes("--freshness-only");

  if (!categoryArg) {
    console.error(
      "Usage: npm run remove-release-date -- --freshness-only [--dry-run] [--limit N]\n" +
        "   or: npm run remove-release-date -- <category-slug|all> [--dry-run] [--limit N]",
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const wordpress = app.get(WordpressService);

  let result;
  if (freshnessOnly) {
    const stateFile = join(process.cwd(), "freshness-state.json");
    if (!existsSync(stateFile)) {
      console.error("freshness-state.json not found - nothing to check.");
      await app.close();
      process.exit(1);
    }
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { posts: Record<string, string> };
    const postIds = Object.keys(state.posts).map(Number);
    console.log(`Checking ${postIds.length} posts from freshness-state.json...`);
    result = await processPostIds(postIds, wordpress, dryRun, limit);
  } else {
    const slugsToScan = categoryArg === "all" ? CATEGORY_SLUGS : [categoryArg];
    result = await processCategories(slugsToScan, wordpress, dryRun, limit);
  }

  console.log(
    `\nDone. Seen ${result.seen} posts, cleaned ${result.cleaned}, ${result.failed} failed.` +
      (dryRun ? " [DRY RUN - nothing written]" : ""),
  );

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
