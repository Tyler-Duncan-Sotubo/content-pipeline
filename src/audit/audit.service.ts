import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { WordpressService, WpCredentials } from "../publish/wordpress.service";
import { AuditGeneratorService } from "./audit-generator.service";
import { AuditStateService } from "./audit-state.service";
import { LinksService } from "../links/links.service";

// A floor for detecting genuinely thin/broken posts (under this, a post almost
// certainly doesn't serve search intent at all) - not a target length. The
// rewrite prompt writes for search intent, not to hit a word count.
const MIN_WORD_COUNT = 400;
const STRAY_TEXT_PATTERNS = [/\badvertisement\b/i, /\blorem ipsum\b/i, /\[insert[^\]]*\]/i, /\[TBD\]/i];

/**
 * Only rewrite actual song-review posts, identified by URL path - never news,
 * lyrics, editorial, or other post types that happen to mention an artist's
 * name. Rewriting a lyrics page or a news article as a song review is wrong,
 * not just thin - the audit must never do that.
 */
const REVIEWABLE_PATH_PATTERNS = [/\/download-mp3\//i, /\/tanzania\//i, /\/ghana-music\//i];

function isReviewablePost(link: string): boolean {
  return REVIEWABLE_PATH_PATTERNS.some((p) => p.test(link));
}

export interface AuditRunSummary {
  artists: string[];
  postsChecked: number;
  postsFixed: number;
  postsSkipped: number;
  results: {
    postLink: string;
    status: "fixed" | "clean" | "skipped" | "failed";
    issues?: string[];
    error?: string;
  }[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts non-text embeds (images, iframes - Spotify/audio players, figures
 * with captions) from the original content so they can be re-attached after
 * an LLM rewrite. The rewrite only ever sees/produces plain text paragraphs;
 * without this, every content_rewrite silently deletes the post's image and
 * Spotify/audio embed (confirmed happening in production - see commit history).
 */
function extractEmbeds(html: string): string[] {
  const embeds: string[] = [];

  // <figure> blocks first (they may wrap an <img>) - remove them from the
  // working copy so the later bare-<img> pass doesn't also capture the same
  // image a second time. Without this, a figure-wrapped image is extracted
  // twice (once as the figure, once as the img inside it) and gets rendered
  // twice in the rebuilt post.
  const figureMatches = html.match(/<figure[\s\S]*?<\/figure>/gi) ?? [];
  embeds.push(...figureMatches);
  let remaining = html;
  for (const figure of figureMatches) {
    remaining = remaining.replace(figure, "");
  }

  const imgMatches = remaining.match(/<img[^>]*>/gi) ?? [];
  embeds.push(...imgMatches);

  const iframeMatches = remaining.match(/<iframe[\s\S]*?<\/iframe>/gi) ?? [];
  embeds.push(...iframeMatches);

  return embeds;
}

/**
 * There is no WordPress taxonomy linking posts to tooxclusive's /artists/
 * pages (confirmed: only "category" and "post_tag" exist via the REST API -
 * /artists/ is standalone custom content, not a taxonomy). So the only way
 * to link a post to the artist's profile page is a plain <a> in the body text.
 */
function artistSlug(artist: string): string {
  return artist
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extracts collaborator names from a full post title like "Adekunle Gold –
 * Formation feat. Olamide" -> ["Adekunle Gold", "Olamide"]. Splits off the
 * song title first (on -/–/—), then splits the artist portion on ft./feat/&/x,
 * since ft./feat can appear either before or after the dash (e.g. "Fameye Ft
 * X – Song" vs "Artist – Song feat. X").
 */
function splitCollaborators(postTitle: string): string[] {
  const collabSplit = /\s*(?:ft\.?|feat\.?|featuring|&|,|\bx\b)\s*/i;
  const [artistPart, ...songParts] = postTitle.split(/\s*[-–—]\s*/);
  const songPart = songParts.join(" - ");
  const names = [...artistPart.split(collabSplit), ...songPart.split(collabSplit).slice(1)];
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

/**
 * Links the first mention of each artist's name in the body. If the artist has
 * a tooxclusive /artists/ profile page (i.e. is in the audit roster), link
 * there; otherwise leave it as plain text - resolveTags() already gives them
 * a WordPress /tag/ page, which is the fallback link surface for artists
 * without a dedicated profile.
 */
function linkArtistNames(bodyHtml: string, artists: string[], rosterArtists: Set<string>): string {
  let result = bodyHtml;
  for (const artist of artists) {
    if (!rosterArtists.has(artist.toLowerCase())) continue; // no /artists/ page - leave as plain text
    const slug = artistSlug(artist);
    const url = `https://tooxclusive.com/artists/${slug}/`;
    const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "i");
    let linked = false;
    result = result.replace(pattern, (match) => {
      if (linked) return match;
      linked = true;
      return `<a href="${url}">${match}</a>`;
    });
  }
  return result;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly maxPerRun: number;
  private readonly logFile = join(process.cwd(), "audit-changes.log");

  constructor(
    private readonly config: ConfigService,
    private readonly wordpress: WordpressService,
    private readonly generator: AuditGeneratorService,
    private readonly state: AuditStateService,
    private readonly links: LinksService,
  ) {
    this.maxPerRun = Number(config.get("AUDIT_MAX_PER_RUN") ?? 5);
  }

  private loadArtists(filename: string): string[] {
    const file = join(process.cwd(), filename);
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf8")) as string[];
  }

  /** Detects issues in a post. Returns an empty array if the post looks fine. */
  private detectIssues(input: {
    excerpt: string;
    contentHtml: string;
    tags: number[];
  }): { issues: string[]; wordCount: number; cleanText: string; embeds: string[] } {
    const issues: string[] = [];
    const cleanExcerpt = stripHtml(input.excerpt);
    const cleanContent = stripHtml(input.contentHtml);
    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;
    const embeds = extractEmbeds(input.contentHtml);

    if (!cleanExcerpt || cleanExcerpt.length < 20) {
      issues.push("missing_or_short_excerpt");
    }
    if (STRAY_TEXT_PATTERNS.some((p) => p.test(cleanExcerpt))) {
      issues.push("stray_text_in_excerpt");
    }
    if (STRAY_TEXT_PATTERNS.some((p) => p.test(cleanContent))) {
      issues.push("stray_text_in_content");
    }
    if (wordCount < MIN_WORD_COUNT) {
      issues.push("thin_content");
    }
    if (input.tags.length === 0) {
      issues.push("missing_tags");
    }
    if (!embeds.some((e) => /<iframe/i.test(e))) {
      issues.push("missing_spotify");
    }

    return { issues, wordCount, cleanText: cleanContent, embeds };
  }

  private logChange(postLink: string, issues: string[], fixesApplied: string[]): void {
    const line = `${new Date().toISOString()} | ${postLink} | issues=[${issues.join(",")}] | fixes=[${fixesApplied.join(",")}]\n`;
    appendFileSync(this.logFile, line);
  }

  /**
   * Audits and fixes existing posts for a list of artists (audit-artists.json
   * by default). For each flagged post: rewrites thin/broken content via LLM,
   * sets a real excerpt, and attaches the artist tag if missing.
   */
  async runAudit(artistsOverride?: string[], limitOverride?: number): Promise<AuditRunSummary> {
    const artists = artistsOverride?.length ? artistsOverride : this.loadArtists("audit-artists.json");
    const limit = limitOverride ?? this.maxPerRun;
    const credentials: WpCredentials | undefined = undefined; // audits use the default WP_USER account

    // Full roster (not just this run's artist list) - used to decide whether a
    // collaborator gets an /artists/ page link or falls back to a plain tag.
    const rosterArtists = new Set(this.loadArtists("audit-artists.json").map((a) => a.toLowerCase()));

    const summary: AuditRunSummary = {
      artists,
      postsChecked: 0,
      postsFixed: 0,
      postsSkipped: 0,
      results: [],
    };

    let fixedThisRun = 0;

    for (const artist of artists) {
      if (fixedThisRun >= limit) break;

      this.logger.log(`Auditing posts for "${artist}"`);
      const posts = await this.wordpress.findPostsByArtist(artist, 20, credentials);

      for (const post of posts) {
        if (fixedThisRun >= limit) break;
        if (this.state.isAudited(post.id)) continue;

        if (!isReviewablePost(post.link)) {
          // Not a song-review page (news, lyrics, editorial, etc.) - only tags
          // are safe to touch here, never the content/excerpt. Handled below
          // by simply not counting it as checked/rewritable; skip entirely.
          continue;
        }

        summary.postsChecked++;
        try {
          const full = await this.wordpress.getPostForAudit(post.id, credentials);
          const { issues, wordCount, cleanText, embeds } = this.detectIssues(full);

          // All artists on the track (title may read "A Ft. B") - both get
          // tagged and linked, not just the one this run happened to search for.
          const collaborators = splitCollaborators(post.title);
          const allArtists = collaborators.length > 0 ? collaborators : [artist];

          const existingTagNames = await this.wordpress.getTagNames(full.tags, credentials);
          const missingCollaborators = allArtists.filter(
            (a) => !existingTagNames.some((t) => t.toLowerCase() === a.toLowerCase())
          );
          if (missingCollaborators.length > 0 && !issues.includes("missing_tags")) {
            issues.push("missing_tags");
          }

          if (issues.length === 0) {
            this.state.markAudited(post.id, false, []);
            summary.results.push({ postLink: post.link, status: "clean" });
            continue;
          }

          this.logger.log(`Issues on "${post.title}": ${issues.join(", ")} (${wordCount} words)`);

          const fixesApplied: string[] = [];
          const changes: { content?: string; excerpt?: string; tags?: number[] } = {};

          // Look up a Spotify embed once, reused whether or not a rewrite happens.
          let spotifyEmbed: string | undefined;
          if (issues.includes("missing_spotify")) {
            const embedUrl = await this.links.findSpotifyEmbedUrl(artist, post.title);
            if (embedUrl) {
              spotifyEmbed = `<iframe style="border-radius:12px" width="100%" height="152" frameborder="0" allowfullscreen allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" src="${embedUrl}?utm_source=oembed"></iframe>`;
            } else {
              this.logger.warn(`No Spotify match found for "${post.title}" - leaving without a player`);
            }
          }

          const needsRewrite =
            issues.includes("thin_content") ||
            issues.includes("stray_text_in_content") ||
            issues.includes("stray_text_in_excerpt") ||
            issues.includes("missing_or_short_excerpt");

          if (needsRewrite) {
            const rewritten = await this.generator.rewriteThinArticle({
              artist,
              title: post.title,
              existingText: cleanText,
              wordCount,
            });

            const rewrittenIsClean =
              !STRAY_TEXT_PATTERNS.some((p) => p.test(rewritten.bodyHtml)) &&
              !STRAY_TEXT_PATTERNS.some((p) => p.test(rewritten.excerpt));

            if (!rewrittenIsClean) {
              // The LLM itself introduced stray/placeholder text - don't save it.
              // Leave the post as-is and let the next run try again.
              this.logger.warn(`Rewrite for "${post.title}" contained stray text - discarding, not saving`);
              summary.results.push({
                postLink: post.link,
                status: "failed",
                error: "LLM rewrite contained stray/placeholder text",
              });
              continue;
            }

            // Re-attach the original image/iframe embeds: first embed (usually
            // the cover image) goes at the top, everything else (Spotify/audio
            // player, additional images) goes after the rewritten text - same
            // placement the original content and the main pipeline both use.
            const [firstEmbed, ...restEmbeds] = embeds;
            if (spotifyEmbed) restEmbeds.push(spotifyEmbed);
            // Link each collaborator's first name-mention to their /artists/
            // page (if on the roster) - the only available way to connect a
            // post to that page, since no taxonomy relationship exists.
            const linkedBody = linkArtistNames(rewritten.bodyHtml, allArtists, rosterArtists);
            changes.content = [
              firstEmbed ? `<p>${firstEmbed}</p>` : "",
              linkedBody,
              ...restEmbeds.map((e) => `<p>${e}</p>`),
            ]
              .filter(Boolean)
              .join("\n");
            changes.excerpt = rewritten.excerpt;
            fixesApplied.push("content_rewrite", "excerpt", "artist_link");
            if (spotifyEmbed) fixesApplied.push("spotify_embed");
          } else if (spotifyEmbed) {
            // No rewrite needed, but a Spotify embed was missing - append it
            // to the existing content as-is, before the fallback footer text.
            changes.content = `${full.contentHtml}\n<p>${spotifyEmbed}</p>`;
            fixesApplied.push("spotify_embed");
          }

          if (issues.includes("missing_tags")) {
            // Keep existing tags and add whichever collaborators aren't tagged
            // yet - a post already tagged with one artist shouldn't lose that
            // tag just because a co-artist was missing.
            const newTagIds = await this.wordpress.resolveTags(missingCollaborators, credentials);
            const tagIds = [...new Set([...full.tags, ...newTagIds])];
            if (tagIds.length > 0) {
              changes.tags = tagIds;
              fixesApplied.push("tags");
            }
          }

          if (Object.keys(changes).length > 0) {
            await this.wordpress.updatePost(post.id, changes, credentials);
            this.logChange(post.link, issues, fixesApplied);
            fixedThisRun++;
            summary.postsFixed++;
            this.state.markAudited(post.id, true, fixesApplied);
            summary.results.push({ postLink: post.link, status: "fixed", issues });
            this.logger.log(`Fixed "${post.title}" (${fixesApplied.join(", ")}): ${post.link}`);
          } else {
            this.state.markAudited(post.id, true, []);
            summary.postsSkipped++;
            summary.results.push({ postLink: post.link, status: "skipped", issues });
          }
        } catch (err) {
          const message = (err as Error).message;
          this.logger.error(`Audit failed for "${post.title}": ${message}`);
          summary.results.push({ postLink: post.link, status: "failed", error: message });
        }
      }
    }

    return summary;
  }
}
