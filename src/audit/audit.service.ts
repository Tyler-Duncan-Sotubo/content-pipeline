import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { WordpressService, WpCredentials } from "../publish/wordpress.service";
import { AuditGeneratorService } from "./audit-generator.service";
import { AuditStateService } from "./audit-state.service";

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
  }): { issues: string[]; wordCount: number; cleanText: string } {
    const issues: string[] = [];
    const cleanExcerpt = stripHtml(input.excerpt);
    const cleanContent = stripHtml(input.contentHtml);
    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;

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

    return { issues, wordCount, cleanText: cleanContent };
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
          const { issues, wordCount, cleanText } = this.detectIssues(full);

          if (issues.length === 0) {
            this.state.markAudited(post.id, false, []);
            summary.results.push({ postLink: post.link, status: "clean" });
            continue;
          }

          this.logger.log(`Issues on "${post.title}": ${issues.join(", ")} (${wordCount} words)`);

          const fixesApplied: string[] = [];
          const changes: { content?: string; excerpt?: string; tags?: number[] } = {};

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

            changes.content = rewritten.bodyHtml;
            changes.excerpt = rewritten.excerpt;
            fixesApplied.push("content_rewrite", "excerpt");
          }

          if (issues.includes("missing_tags")) {
            const tagIds = await this.wordpress.resolveTags([artist], credentials);
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
