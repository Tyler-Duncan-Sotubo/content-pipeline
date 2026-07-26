/**
 * Additive-only backfill for already-published TZ/Ghana/Kenya/Gospel posts:
 *   - Adds any missing artist tags (union with existing tags - never removes any)
 *   - Links the "Artist:"/"Genre:" metadata lines if they're still plain text
 *     (skips posts where they're already linked, so this is safe to re-run)
 *
 * Never overwrites title/excerpt/body copy/category/featured image - only tags
 * and, within content, the two metadata lines.
 *
 * Usage: npm run backfill:tags -- <TZ|GHANA|KENYA|GOSPEL> [--dry-run]
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { WordpressService, WpCredentials } from "./publish/wordpress.service";
import { COUNTRIES, GOSPEL_SOURCE, GHANA_SOURCE, KENYA_SOURCE } from "./countries";

interface Target {
  categoryName: string;
  categorySlug: string;
  credentials?: WpCredentials;
}

function targetFor(name: string, config: ConfigService): Target {
  const upper = name.toUpperCase();
  if (upper === "TZ") {
    return { categoryName: COUNTRIES.TZ.wpCategory, categorySlug: COUNTRIES.TZ.wpCategorySlug };
  }
  if (upper === "GOSPEL") {
    const user = config.get<string>("WP_USER_GOSPEL");
    const password = config.get<string>("WP_APP_PASSWORD_GOSPEL");
    return {
      categoryName: GOSPEL_SOURCE.wpCategory,
      categorySlug: GOSPEL_SOURCE.wpCategorySlug,
      credentials: user && password ? { user, appPassword: password } : undefined,
    };
  }
  if (upper === "GHANA") {
    const user = config.get<string>("WP_USER_GHANA");
    const password = config.get<string>("WP_APP_PASSWORD_GHANA");
    return {
      categoryName: GHANA_SOURCE.wpCategory,
      categorySlug: GHANA_SOURCE.wpCategorySlug,
      credentials: user && password ? { user, appPassword: password } : undefined,
    };
  }
  if (upper === "KENYA") {
    const user = config.get<string>("WP_USER_KENYA");
    const password = config.get<string>("WP_APP_PASSWORD_KENYA");
    return {
      categoryName: KENYA_SOURCE.wpCategory,
      categorySlug: KENYA_SOURCE.wpCategorySlug,
      credentials: user && password ? { user, appPassword: password } : undefined,
    };
  }
  throw new Error(`Unknown target "${name}". Use TZ, GHANA, KENYA, or GOSPEL.`);
}

/** WP's `title.rendered` is HTML-entity-encoded (e.g. "&#8211;" for the en-dash, "&amp;" for "&"). */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&");
}

/**
 * Pulls the artist straight out of the post's own existing
 * "<strong>Artist:</strong> X<br>" metadata line - the ground truth for what
 * this specific post was published with, rather than re-guessing from the
 * title. Returns undefined for any post that doesn't have this metadata
 * block at all, which is exactly the signal that a post is NOT one of this
 * pipeline's song reviews (e.g. an editorial/feature article) and must be
 * left alone entirely.
 */
function parseArtistFromContent(content: string): string | undefined {
  const match = content.match(/<strong>Artist:<\/strong>\s*(?:<a[^>]*>)?([^<]+?)(?:<\/a>)?\s*<br/i);
  if (!match) return undefined;
  return decodeHtmlEntities(match[1]).trim() || undefined;
}

function splitArtists(name: string): string[] {
  const split = name.split(/\s*(?:ft\.?|feat\.?|featuring|&|,|\bx\b)\s*/i).filter(Boolean);
  return [...new Set(split.map((n) => n.trim()).filter(Boolean))];
}

async function run() {
  const [, , targetArg, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");
  if (!targetArg) {
    console.error("Usage: npm run backfill:tags -- <TZ|GHANA|KENYA|GOSPEL> [--dry-run]");
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  const wordpress = app.get(WordpressService);
  const target = targetFor(targetArg, config);

  const categoryId = await wordpress.resolveCategoryId(target.categoryName, target.credentials);
  if (!categoryId) {
    console.error(`Could not resolve category "${target.categoryName}" - aborting.`);
    await app.close();
    process.exit(1);
  }

  const wpUrl = config.getOrThrow<string>("WP_URL").replace(/\/$/, "");
  const categoryUrl = `${wpUrl}/${target.categorySlug}`;

  let page = 1;
  let totalTagsAdded = 0;
  let totalLinksAdded = 0;
  let totalPostsTouched = 0;
  let totalPostsSeen = 0;

  for (;;) {
    let posts;
    try {
      posts = await wordpress.listPostsByCategory(categoryId, page, 50, target.credentials);
    } catch (err) {
      // WP 400s on requesting a page past the last one - treat as end of pagination.
      if ((err as Error).message.includes("400")) break;
      throw err;
    }
    if (posts.length === 0) break;

    for (const post of posts) {
      totalPostsSeen++;
      const title = post.title.rendered;
      const artist = parseArtistFromContent(post.content.rendered);
      if (!artist) {
        console.warn(
          `[skip] Post ${post.id} "${title}" - no "Artist:" metadata block found (not a song-review post - leaving untouched)`,
        );
        continue;
      }

      const artistNames = splitArtists(artist);
      let newTagIds: number[] = [];
      try {
        newTagIds = await wordpress.resolveTagsOnly(artistNames, target.credentials);
      } catch (err) {
        console.warn(`[skip-tags] Post ${post.id} "${title}": ${(err as Error).message}`);
      }
      const existingTags = new Set(post.tags);
      const missingTagIds = newTagIds.filter((id) => !existingTags.has(id));
      const mergedTags = missingTagIds.length > 0 ? [...post.tags, ...missingTagIds] : undefined;

      let content = post.content.rendered;
      let contentChanged = false;

      const artistAlreadyLinked = /<strong>Artist:<\/strong>\s*<a\b/i.test(content);
      if (!artistAlreadyLinked) {
        const primaryArtist = artistNames[0] ?? artist;
        const artistPage = await wordpress.findArtistPage(primaryArtist, target.credentials);
        const artistUrl =
          artistPage?.link ??
          `${wpUrl}/tag/${primaryArtist.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/`;
        const before = content;
        content = content.replace(
          /(<strong>Artist:<\/strong>\s*)([^<]+?)(\s*<br\s*\/?>)/i,
          (_m, prefix, text, suffix) => `${prefix}<a href="${artistUrl}">${text.trim()}</a>${suffix}`,
        );
        if (content !== before) contentChanged = true;
      }

      const genreAlreadyLinked = /<strong>Genre:<\/strong>\s*<a\b/i.test(content);
      if (!genreAlreadyLinked) {
        const before = content;
        content = content.replace(
          /(<strong>Genre:<\/strong>\s*)([^<]+?)(\s*<br\s*\/?>)/i,
          (_m, prefix, text, suffix) => `${prefix}<a href="${categoryUrl}">${text.trim()}</a>${suffix}`,
        );
        if (content !== before) contentChanged = true;
      }

      if (!mergedTags && !contentChanged) continue;

      totalPostsTouched++;
      if (mergedTags) totalTagsAdded += missingTagIds.length;
      if (contentChanged) totalLinksAdded++;

      const summary = [
        mergedTags ? `+${missingTagIds.length} tag(s)` : null,
        contentChanged ? "linked metadata" : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`[${dryRun ? "dry-run" : "update"}] Post ${post.id} "${title}": ${summary}`);

      if (!dryRun) {
        const patch = {
          ...(mergedTags ? { tags: mergedTags } : {}),
          ...(contentChanged ? { content } : {}),
        };
        try {
          await wordpress.patchPost(post.id, patch, target.credentials);
        } catch (err) {
          // Some older posts were published under the default WP_USER account
          // before a dedicated per-pipeline user existed - that dedicated user
          // can lack edit rights on them. Retry once under the default
          // account before giving up on this post.
          if ((err as Error).message.includes("403") && target.credentials) {
            try {
              await wordpress.patchPost(post.id, patch, undefined);
            } catch (retryErr) {
              console.warn(`[skip-write] Post ${post.id} "${title}": ${(retryErr as Error).message}`);
              continue;
            }
          } else {
            console.warn(`[skip-write] Post ${post.id} "${title}": ${(err as Error).message}`);
            continue;
          }
        }
      }
    }

    page++;
  }

  console.log(
    `\nDone. Seen ${totalPostsSeen} posts, touched ${totalPostsTouched} ` +
      `(${totalTagsAdded} tags added, ${totalLinksAdded} posts got linked metadata).` +
      (dryRun ? " [DRY RUN - nothing written]" : ""),
  );

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
