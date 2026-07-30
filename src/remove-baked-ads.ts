/**
 * Removes Advanced Ads "Before Content"/"After Content" ad blocks that are
 * permanently baked into post_content (not live-injected by the plugin at
 * render time). Disabling the placement in Advanced Ads only stops it being
 * added to NEW posts - it can't remove what's already saved in existing
 * posts' bodies, which is why these ads kept showing on posts even after
 * the placement was turned off.
 *
 * Confirmed live structure (consistent across every post checked):
 *   <div id="tooxc-XXXXXXXX" class="tooxc-before-content tooxc-entity-placement ...">
 *     <div class="advads-edit-bar ...">...</div>
 *     <p><iframe ...></iframe></div>
 *   (same for tooxc-after-content)
 *
 * Only removes these specific ad-placement divs - nothing else in the post
 * (title, real body paragraphs, images, embeds, byline) is touched.
 *
 * Usage: npm run remove-baked-ads -- <category-slug> [--dry-run] [--limit N]
 * Scans the same 9 categories the freshness system manages if no slug given:
 *   npm run remove-baked-ads -- all [--dry-run]
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";

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

const BAKED_AD_REGEX =
  /<div id="tooxc-\d+" class="tooxc-(?:before|after)-content[^"]*"[^>]*>[\s\S]*?<\/iframe><\/div>\s*/g;

function stripBakedAds(content: string): { content: string; removed: number } {
  const matches = content.match(BAKED_AD_REGEX) ?? [];
  const cleaned = content.replace(BAKED_AD_REGEX, "");
  return { content: cleaned, removed: matches.length };
}

async function run() {
  const [, , categoryArg, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");
  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : Infinity;

  if (!categoryArg) {
    console.error("Usage: npm run remove-baked-ads -- <category-slug|all> [--dry-run] [--limit N]");
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const wordpress = app.get(WordpressService);

  const slugsToScan = categoryArg === "all" ? CATEGORY_SLUGS : [categoryArg];

  let totalSeen = 0;
  let totalCleaned = 0;
  let totalAdsRemoved = 0;
  let totalFailed = 0;

  for (const slug of slugsToScan) {
    const categoryId = await wordpress.resolveCategoryIdBySlug(slug);
    if (!categoryId) {
      console.warn(`Could not resolve category slug "${slug}" - skipping`);
      continue;
    }

    let page = 1;
    for (;;) {
      if (totalCleaned >= limit) break;
      let posts;
      try {
        posts = await wordpress.listPostsByCategoryNewestFirst(categoryId, page, 100);
      } catch (err) {
        if ((err as Error).message.includes("400")) break;
        throw err;
      }
      if (posts.length === 0) break;

      for (const post of posts) {
        if (totalCleaned >= limit) break;
        totalSeen++;

        const { content, removed } = stripBakedAds(post.content.rendered);
        if (removed === 0) continue;

        totalCleaned++;
        totalAdsRemoved += removed;
        console.log(`[${dryRun ? "dry-run" : "clean"}] Post ${post.id} (${post.link}): removed ${removed} ad block(s)`);

        if (!dryRun) {
          try {
            await wordpress.patchPost(post.id, { content });
          } catch (err) {
            totalFailed++;
            console.warn(`  FAILED to save post ${post.id}: ${(err as Error).message}`);
          }
        }
      }
      page++;
    }
  }

  console.log(
    `\nDone. Seen ${totalSeen} posts, cleaned ${totalCleaned} (${totalAdsRemoved} ad blocks removed), ${totalFailed} failed.` +
      (dryRun ? " [DRY RUN - nothing written]" : ""),
  );

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
