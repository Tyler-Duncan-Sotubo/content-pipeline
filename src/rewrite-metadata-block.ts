/**
 * One-off backfill: rewrites the old "Artist:/Artists:/Song Title:/Genre:"
 * metadata block in download-mp3 posts into a new format:
 *
 *   Artist Name: {primary artist, linked to /artists/{slug}/ if it exists}
 *   featuring: {other artists, same-page-if-exists linking} (omitted if solo)
 *   Track Title: {song title}
 *   Recorded: {year} Music (from the post's publish date)
 *   Country: Naija Music
 *   Album Name: {album name, if present in the post's own content} (omitted otherwise)
 *   Category: Latest Music
 *
 * "Produced By" is deliberately never included - it isn't present in any
 * existing post, and this script only uses data that's actually there.
 *
 * Usage:
 *   npm run rewrite-metadata -- [--dry-run] [--limit N]
 *   npm run rewrite-metadata -- --repair-ids 1,2,3 [--dry-run]
 *     Re-derives the block for posts ALREADY migrated to the new format
 *     (e.g. by an earlier, buggy run of this same script) and only writes
 *     if the corrected block differs from what's currently live.
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";
import { stripBakedAds } from "./strip-baked-ads";

function prepareForSave(content: string): string {
  return stripBakedAds(content).content;
}

// A mass post_date-rewrite incident (confirmed live earlier: thousands of
// old posts across Jan-Mar 2026 have fake recent `date` values) makes the
// publish date unreliable below this post ID - the freshness system uses
// the same floor. Skip these posts rather than derive a "Recorded" year
// from a date that may not be real.
const MIN_TRUSTWORTHY_POST_ID = 615731;

const NAIJA_MUSIC_URL = "https://tooxclusive.com/latest-nigerian-songs/";
const LATEST_MUSIC_URL = "https://tooxclusive.com/category/download-mp3/";

const OLD_BLOCK_REGEX =
  /<p><strong>Artists?:<\/strong>\s*(.*?)\s*<br\s*\/?>\s*<strong>Song Title:<\/strong>\s*(.*?)\s*<br\s*\/?>\s*<strong>Genre:<\/strong>\s*(.*?)\s*<\/p>/is;

// Matches the NEW block format this script itself writes, used only by
// --repair-ids to re-derive a corrected block for posts already migrated
// by an earlier, buggy run (see fix history in buildNewBlock/parseArtistRefs).
const NEW_BLOCK_ARTIST_LINE_REGEX =
  /<strong>Artist Name:<\/strong>\s*(.*?)\s*<br\s*\/?>\s*(?:<strong>featuring:<\/strong>\s*(.*?)\s*<br\s*\/?>\s*)?<strong>Track Title:<\/strong>\s*(.*?)\s*<br/is;
const NEW_BLOCK_FULL_REGEX =
  /<p><strong>Artist Name:<\/strong>[\s\S]*?<strong>Category:<\/strong>\s*(?:<a[^>]*>)?Latest Music(?:<\/a>)?\s*<\/p>/i;

// Matches an existing album link/figcaption in the post body. Prefer the
// real /albums/{slug}/ link (preserves the href) over the figcaption, which
// is plain text only.
const ALBUM_LINK_REGEX = /<a href="([^"]*\/albums\/[^"]*)"[^>]*>(?:<[^>]+>)*\s*([^<]+?)\s*(?:<\/[^>]+>)*<\/a>/i;
const ALBUM_FIGCAPTION_REGEX = /Album:\s*[^<]*?[-–]\s*([^<]+?)<\/figcaption>/i;

interface ArtistRef {
  name: string;
  href?: string;
}

// &amp; must be unescaped BEFORE splitting on delimiters - splitting on the
// raw "&" would otherwise cut "&amp;" in half and leave a stray "amp;"
// fragment (confirmed live: turned "Mayorkun &amp; FOLA" into "Mayorkun"
// plus a broken "amp; FOLA" fragment).
function unescapeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#8217;/g, "’");
}

// Splits a raw artist-line HTML fragment (which may contain <a> tags around
// individual names) into ordered artist refs, preserving any href already
// present, e.g. '<a href="...">Davido</a> ft. Mayorkun & FOLA'.
function parseArtistRefs(rawLine: string): ArtistRef[] {
  const parts = unescapeEntities(rawLine)
    .split(/\s*(?:ft\.?|feat\.?|featuring|&|,|\bx\b)\s*/i)
    .filter(Boolean);
  return parts.map((part) => {
    const linked = part.match(/<a href="([^"]*)"[^>]*>([^<]+)<\/a>/i);
    if (linked) return { name: linked[2].trim(), href: linked[1] };
    // A previous buggy run of this script left a stray "amp;" text token
    // in some already-written posts (the corrupted "&amp;" had already
    // lost its "&" by the time it reached this function) - strip it as a
    // leading token rather than treating it as part of the artist's name.
    const cleaned = part.replace(/<[^>]+>/g, "").replace(/^\s*amp;\s*/i, "");
    return { name: cleaned.trim() };
  });
}

function cleanText(s: string): string {
  return unescapeEntities(s.replace(/<a[^>]*>|<\/a>|<strong>|<\/strong>|<em>|<\/em>/gi, "")).trim();
}

async function resolveArtistUrl(
  ref: ArtistRef,
  wordpress: WordpressService,
): Promise<string | undefined> {
  // Always re-verify against the real /artists/ page lookup rather than
  // trusting a pre-existing href baked into the old post - confirmed live
  // that some old posts link artist names to bad/unrelated URLs (e.g.
  // "/stats/artists/aj-tracey", a stray page that happens to contain
  // "/artists/" as a substring but isn't a real artist bio page).
  //
  // findArtistPage swallows network errors and returns undefined on failure,
  // so a transient blip would otherwise silently look identical to "no page
  // exists" - retry once before accepting that as the real answer.
  let page = await wordpress.findArtistPage(ref.name);
  if (!page) page = await wordpress.findArtistPage(ref.name);
  if (page) return page.link;
  return ref.href?.includes("/tag/") ? ref.href : undefined;
}

function linkedName(name: string, url: string | undefined): string {
  return url ? `<a href="${url}">${name}</a>` : name;
}

async function buildNewBlock(
  rawArtistRefs: ArtistRef[],
  rawSongTitle: string,
  content: string,
  postDate: string,
  wordpress: WordpressService,
): Promise<string> {
  const [primary, ...featuring] = rawArtistRefs;

  const primaryUrl = await resolveArtistUrl(primary, wordpress);
  const primaryHtml = linkedName(primary.name, primaryUrl);

  const featuringHtml: string[] = [];
  for (const ref of featuring) {
    const url = await resolveArtistUrl(ref, wordpress);
    featuringHtml.push(linkedName(ref.name, url));
  }

  const trackTitle = cleanText(rawSongTitle);
  const year = new Date(postDate).getFullYear();

  const albumLinkMatch = content.match(ALBUM_LINK_REGEX);
  let albumHtml: string | undefined;
  if (albumLinkMatch) {
    albumHtml = `<a href="${albumLinkMatch[1]}">${cleanText(albumLinkMatch[2])}</a>`;
  } else {
    const figcaptionMatch = content.match(ALBUM_FIGCAPTION_REGEX);
    albumHtml = figcaptionMatch ? cleanText(figcaptionMatch[1]) : undefined;
  }

  const lines = [`<strong>Artist Name:</strong> ${primaryHtml}`];
  if (featuringHtml.length > 0) {
    lines.push(`<strong>featuring:</strong> ${featuringHtml.join(", ")}`);
  }
  lines.push(`<strong>Track Title:</strong> ${trackTitle}`);
  lines.push(`<strong>Recorded:</strong> ${year} Music`);
  lines.push(`<strong>Country:</strong> <a href="${NAIJA_MUSIC_URL}">Naija Music</a>`);
  if (albumHtml) {
    lines.push(`<strong>Album Name:</strong> ${albumHtml}`);
  }
  lines.push(`<strong>Category:</strong> <a href="${LATEST_MUSIC_URL}">Latest Music</a>`);

  return `<p>${lines.join("<br />\n")}</p>`;
}

// Re-derives a corrected block for posts already migrated to the new format
// by an earlier, buggy run of this script - fixes are applied via the same
// buildNewBlock/parseArtistRefs logic now that those bugs are fixed. Only
// writes if the corrected block actually differs from what's live.
async function repairPosts(
  postIds: number[],
  wordpress: WordpressService,
  dryRun: boolean,
): Promise<{ seen: number; fixed: number; failed: number }> {
  let seen = 0;
  let fixed = 0;
  let failed = 0;

  for (const postId of postIds) {
    seen++;
    const post = await wordpress.getPostContent(postId);
    const content = post.content;

    const fullMatch = content.match(NEW_BLOCK_FULL_REGEX)?.[0];
    const lineMatch = content.match(NEW_BLOCK_ARTIST_LINE_REGEX);
    if (!fullMatch || !lineMatch) {
      console.log(`[skip] Post ${postId} (${post.link}): new block not found`);
      continue;
    }

    const [, rawArtistName, rawFeaturing, rawSongTitle] = lineMatch;
    const combinedRawLine = rawFeaturing ? `${rawArtistName}, ${rawFeaturing}` : rawArtistName;
    const artistRefs = parseArtistRefs(combinedRawLine);

    // post.date isn't returned by getPostContent - re-derive the Recorded
    // year from what's already in the current (possibly-broken) block
    // rather than an extra API call, since it was never the buggy part.
    const yearMatch = content.match(/<strong>Recorded:<\/strong>\s*(\d{4})/i);
    const postDate = yearMatch ? `${yearMatch[1]}-01-01` : new Date().toISOString();

    const newBlock = await buildNewBlock(artistRefs, rawSongTitle, content, postDate, wordpress);

    if (newBlock === fullMatch) {
      console.log(`[unchanged] Post ${postId} (${post.link})`);
      continue;
    }

    fixed++;
    console.log(`[${dryRun ? "dry-run" : "repair"}] Post ${postId} (${post.link})`);
    console.log(`  before: ${fullMatch.replace(/\n/g, " ")}`);
    console.log(`  after:  ${newBlock.replace(/\n/g, " ")}`);

    if (!dryRun) {
      try {
        const newContent = content.replace(fullMatch, newBlock);
        await wordpress.patchPost(postId, { content: prepareForSave(newContent) });
      } catch (err) {
        failed++;
        console.warn(`  FAILED to save post ${postId}: ${(err as Error).message}`);
      }
    }
  }

  return { seen, fixed, failed };
}

async function run() {
  const flags = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : Infinity;
  const repairIdsIdx = flags.indexOf("--repair-ids");

  process.env.DISABLE_CRONS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const wordpress = app.get(WordpressService);

  if (repairIdsIdx >= 0) {
    const postIds = flags[repairIdsIdx + 1].split(",").map(Number);
    const result = await repairPosts(postIds, wordpress, dryRun);
    console.log(
      `\nDone. Seen ${result.seen} posts, fixed ${result.fixed}, ${result.failed} failed.` +
        (dryRun ? " [DRY RUN - nothing written]" : ""),
    );
    await app.close();
    return;
  }

  const categoryId = await wordpress.resolveCategoryIdBySlug("download-mp3");
  if (!categoryId) {
    console.error('Could not resolve category "download-mp3"');
    await app.close();
    process.exit(1);
  }

  let seen = 0;
  let rewritten = 0;
  let failed = 0;
  let page = 1;

  for (;;) {
    if (rewritten >= limit) break;
    let posts;
    try {
      posts = await wordpress.listPostsByCategoryNewestFirst(categoryId, page, 100);
    } catch (err) {
      if ((err as Error).message.includes("400")) break;
      throw err;
    }
    if (posts.length === 0) break;

    for (const post of posts) {
      if (rewritten >= limit) break;
      seen++;

      const content = post.content.rendered;
      const match = content.match(OLD_BLOCK_REGEX);
      if (!match) continue;

      if (post.id < MIN_TRUSTWORTHY_POST_ID) {
        console.log(
          `[skip] Post ${post.id} (${post.link}): below post ID ${MIN_TRUSTWORTHY_POST_ID} - ` +
            `publish date may be contaminated, skipping rather than guessing "Recorded" year`,
        );
        continue;
      }

      const [fullMatch, rawArtistLine, rawSongTitle] = match;
      const artistRefs = parseArtistRefs(rawArtistLine);
      const newBlock = await buildNewBlock(artistRefs, rawSongTitle, content, post.date, wordpress);
      const newContent = content.replace(fullMatch, newBlock);

      rewritten++;
      console.log(`[${dryRun ? "dry-run" : "rewrite"}] Post ${post.id} (${post.link})`);
      console.log(`  ${newBlock.replace(/\n/g, " ")}`);

      if (!dryRun) {
        try {
          await wordpress.patchPost(post.id, { content: prepareForSave(newContent) });
        } catch (err) {
          failed++;
          console.warn(`  FAILED to save post ${post.id}: ${(err as Error).message}`);
        }
      }
    }
    page++;
  }

  console.log(
    `\nDone. Seen ${seen} posts, rewritten ${rewritten}, ${failed} failed.` +
      (dryRun ? " [DRY RUN - nothing written]" : ""),
  );

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
