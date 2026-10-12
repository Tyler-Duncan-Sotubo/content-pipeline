/**
 * Strips dead legacy MP3 download elements (audio shortcode, DOWNLOAD
 * button, Last verified line) from posts - see strip-dead-mp3.ts for the
 * exact patterns and why they're safe to remove.
 *
 * With --add-link, looks up a real streaming link (Spotify -> YouTube ->
 * Audiomack fallback chain, via LinksService - the same code-driven lookup
 * the main pipeline already uses in buildFooter(), not an LLM guess) using
 * the post's own title as the search query, and inserts it in the exact
 * spot the dead <audio> player occupied - so the post ends up with a
 * working way to listen, not just a gap where the player used to be.
 *
 * Usage:
 *   npm run strip-dead-mp3 -- --id N [--add-link] [--dry-run]
 *     Single post by ID (or use --id with a WP post ID from a URL).
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";
import { LinksService } from "./links/links.service";
import { stripDeadMp3 } from "./strip-dead-mp3";
import { stripBakedAds } from "./strip-baked-ads";

/** Strips HTML entities/tags from a post title so it's a clean search query. */
function cleanTitleForSearch(title: string): string {
  return title
    .replace(/<[^>]+>/g, "")
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function run() {
  const flags = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const addLink = flags.includes("--add-link");
  const idIdx = flags.indexOf("--id");

  if (idIdx < 0) {
    console.error("Usage: npm run strip-dead-mp3 -- --id N [--add-link] [--dry-run]");
    process.exit(1);
  }
  const postId = Number(flags[idIdx + 1]);

  process.env.DISABLE_CRONS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const wordpress = app.get(WordpressService);
  const links = app.get(LinksService);

  const post = await wordpress.getPostContent(postId);
  console.log(`Post ${postId} (${post.link})`);
  console.log(`Title: ${post.title}`);

  let replacementUrl: string | undefined;
  if (addLink) {
    const query = cleanTitleForSearch(post.title);
    console.log(`Looking up streaming link for: "${query}"`);
    const found = await links.findYouTubeThenSpotify(query);
    if (found) {
      replacementUrl = found.url;
      console.log(`Found (${found.platform}): ${found.url}`);
    } else {
      console.log("No streaming link found - will strip without a replacement.");
    }
  }

  const result = stripDeadMp3(post.content, replacementUrl);
  console.log(
    `Removed: audio block x${result.removedAudio}, download button x${result.removedDownloadButton}, ` +
      `last-verified line x${result.removedLastVerified}`,
  );

  if (result.removedAudio === 0 && result.removedDownloadButton === 0 && result.removedLastVerified === 0) {
    console.log("Nothing to remove - content unchanged.");
    await app.close();
    return;
  }

  console.log("\n--- BEFORE ---");
  console.log(post.content);
  console.log("\n--- AFTER ---");
  console.log(result.content);

  if (dryRun) {
    console.log("\n[DRY RUN] Nothing written.");
    await app.close();
    return;
  }

  await wordpress.patchPost(postId, { content: stripBakedAds(result.content).content });
  console.log(`\nSaved post ${postId}.`);
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
