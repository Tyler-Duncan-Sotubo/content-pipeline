import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WordpressService } from "../publish/wordpress.service";

/**
 * Real (not faked) freshness refresh: appends/updates a "by {author} — {date}"
 * line at the top of eligible posts, so post_modified only ever changes as
 * a genuine side effect of a real, visible content edit - never set directly.
 * The author name is the post's own real author (never changed); only the
 * date updates, to the day of the actual refresh.
 *
 * Scope: posts with id >= minPostId (FRESHNESS_MIN_POST_ID env var, default
 * 615731) in CATEGORIES. Filtered by ID, not date - a mass post_date-rewrite
 * incident gave thousands of old posts fake recent `date` values, interleaved
 * second-by-second with genuinely new posts, continuously through at least
 * March 2026 (confirmed live: no clean date cutoff exists). Post ID is
 * monotonically real and can't be faked without creating an actual new post,
 * so it's used as the recency filter instead. The default (615731) is the
 * lowest ID confirmed live to appear only from April 1, 2026 onward with zero
 * old-post contamination.
 *
 * IMPORTANT if you change FRESHNESS_MIN_POST_ID (e.g. to move the cutoff back
 * to January 1): pick a new value carefully. Contamination was NOT a clean
 * date range - old and new post IDs were interleaved second-by-second through
 * March. Verify live (e.g. fetch a handful of posts right at your intended ID
 * boundary and check their IDs/titles look like genuinely new content, not
 * old reused posts) before lowering this.
 *
 * Instead of re-scanning every category on every cron run (wasted API calls
 * re-checking posts that aren't due yet), eligible post IDs are indexed once
 * into freshness-state.json and reused - each cron run just reads that file
 * and filters in memory, only hitting the WP API for posts it actually
 * patches. buildIndex() (re)builds the file and should run periodically
 * (e.g. weekly) to pick up newly published posts; runPass() is the frequent
 * (every-2-hours) job that does the actual refreshing.
 *
 * Rotation: each post is deterministically assigned to 1 of 3 day-groups by
 * post ID (id % 3), so on any given day only ~1/3 of the pool is even
 * eligible - this spreads refreshes into a ~3-day cycle per post rather than
 * refreshing everything daily (much lower load, less mechanical-looking).
 * The refresh interval (default 2.5 days, configurable via
 * FRESHNESS_REFRESH_INTERVAL_DAYS) is intentionally non-integer/jittered
 * relative to the 3-day group cycle so the exact refresh timing isn't
 * perfectly regular per post.
 */
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
// Matches every marker format this service has ever written, anywhere in the
// body (start, middle, or end) - old bottom-placed "Last updated: {date}",
// the plain "by {author} — {date}" version, and the current styled/linked
// version - so switching formats never leaves a duplicate behind.
const BYLINE_MARKER_ANYWHERE_REGEX =
  /\s*<p(?:\s+style="[^"]*")?>(?:<em>)?(?:Last updated:|by\s)[\s\S]*?<\/(?:em><\/p>|p>)\s*/gi;

interface FreshnessState {
  /** Post ID -> ISO timestamp this service last refreshed it (or indexed it, if never refreshed). */
  posts: Record<string, string>;
  indexBuiltAt?: string;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

@Injectable()
export class FreshnessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FreshnessService.name);
  private readonly categoryIds: Map<string, number> = new Map();
  private readonly authorInfo: Map<number, { name: string; link: string }> = new Map();
  private readonly stateFile = join(process.cwd(), "freshness-state.json");
  private readonly refreshIntervalDays: number;
  private readonly dayGroups: number;
  private readonly minPostId: number;

  constructor(
    private readonly wordpress: WordpressService,
    config: ConfigService,
  ) {
    this.refreshIntervalDays = Number(config.get("FRESHNESS_REFRESH_INTERVAL_DAYS") ?? 2.5);
    this.dayGroups = Number(config.get("FRESHNESS_DAY_GROUPS") ?? 3);
    this.minPostId = Number(config.get("FRESHNESS_MIN_POST_ID") ?? 615731);
  }

  /**
   * Auto-builds the index on app startup if it's empty (e.g. right after a
   * fresh deploy, or freshness-state.json was reset to {}). Without this, the
   * refresh cron finds nothing to do until the weekly index-build cron next
   * fires - confirmed in production: index was empty, every 2-hourly refresh
   * pass logged "scanned: 0, refreshed: 0" with nothing to act on. Runs in
   * the background (not awaited) so it doesn't delay app startup; errors are
   * logged, not thrown, so a transient WP API issue can't crash boot.
   */
  onApplicationBootstrap(): void {
    const state = this.loadState();
    if (Object.keys(state.posts).length > 0) {
      this.logger.log(`Freshness index already has ${Object.keys(state.posts).length} posts - skipping auto-build`);
      return;
    }
    this.logger.log("Freshness index is empty - auto-building on startup");
    this.buildIndex().catch((err) => {
      this.logger.error(`Startup index auto-build failed: ${(err as Error).message}`);
    });
  }

  private dayGroupForPostId(postId: number): number {
    return postId % this.dayGroups;
  }

  private todaysDayGroup(): number {
    // Days since a fixed epoch, mod dayGroups - stable across process
    // restarts, rotates which group is "due" each calendar day.
    const epoch = new Date("2026-01-01T00:00:00Z").getTime();
    const daysSinceEpoch = Math.floor((Date.now() - epoch) / (24 * 60 * 60 * 1000));
    return daysSinceEpoch % this.dayGroups;
  }

  private async resolveAuthorInfo(authorId: number): Promise<{ name: string; link: string }> {
    if (!this.authorInfo.has(authorId)) {
      const info = await this.wordpress.getUserInfo(authorId);
      this.authorInfo.set(authorId, info);
    }
    return this.authorInfo.get(authorId)!;
  }

  /**
   * Applies the "by {author} — {date}" marker at the TOP of bodyHtml, author
   * name hyperlinked to their real author archive page, styled small/grey so
   * it reads as a subtle meta line rather than a heading. Strips any existing
   * marker anywhere first (so an old placement/format doesn't linger as a
   * duplicate), then prepends a fresh one. The author is the post's own real
   * author (never altered) - only the date changes, to the day of this refresh.
   */
  refreshContent(
    bodyHtml: string,
    author: { name: string; link: string },
  ): { content: string; changed: boolean } {
    const today = formatDate(new Date());
    const marker =
      `<p style="font-size: 0.85em; color: #777;">by ` +
      `<a href="${author.link}" style="color: #d32f2f;">${author.name}</a> — ${today}</p>\n`;
    const withoutOldMarkers = bodyHtml.replace(BYLINE_MARKER_ANYWHERE_REGEX, "\n").trim();
    const updated = `${marker}${withoutOldMarkers}`;
    return { content: updated, changed: updated !== bodyHtml };
  }

  private loadState(): FreshnessState {
    if (!existsSync(this.stateFile)) return { posts: {} };
    return JSON.parse(readFileSync(this.stateFile, "utf8")) as FreshnessState;
  }

  private saveState(state: FreshnessState): void {
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  private async resolveCategoryIds(): Promise<number[]> {
    const ids: number[] = [];
    for (const slug of CATEGORY_SLUGS) {
      if (!this.categoryIds.has(slug)) {
        // resolveCategoryId matches by NAME, not slug - categories here are
        // looked up by slug directly via a raw request instead.
        const id = await this.wordpress.resolveCategoryIdBySlug(slug);
        if (id) this.categoryIds.set(slug, id);
      }
      const id = this.categoryIds.get(slug);
      if (id) ids.push(id);
    }
    return [...new Set(ids)];
  }

  /**
   * Walks all in-scope categories once and (re)builds freshness-state.json
   * with every eligible post ID (id >= minPostId). Existing entries keep
   * their last-refreshed timestamp; only newly-discovered posts get added
   * with the current time (so a fresh post isn't immediately "overdue").
   * Should be run periodically (e.g. weekly), not on every cron tick.
   */
  async buildIndex(): Promise<{ totalIndexed: number; newlyAdded: number }> {
    const state = this.loadState();
    const categoryIds = await this.resolveCategoryIds();
    let newlyAdded = 0;

    for (const categoryId of categoryIds) {
      let page = 1;
      for (;;) {
        let posts;
        try {
          posts = await this.wordpress.listPostsByCategoryNewestFirst(categoryId, page, 100);
        } catch (err) {
          if ((err as Error).message.includes("400")) break;
          throw err;
        }
        if (posts.length === 0) break;

        let reachedOldPosts = false;
        for (const post of posts) {
          if (post.id < this.minPostId) {
            reachedOldPosts = true;
            break;
          }
          const key = String(post.id);
          if (!(key in state.posts)) {
            state.posts[key] = new Date().toISOString();
            newlyAdded++;
          }
        }
        if (reachedOldPosts) break;
        page++;
      }
    }

    state.indexBuiltAt = new Date().toISOString();
    this.saveState(state);
    const totalIndexed = Object.keys(state.posts).length;
    this.logger.log(`Index built: ${totalIndexed} total posts indexed, ${newlyAdded} newly added`);
    return { totalIndexed, newlyAdded };
  }

  private isDue(lastRefreshedIso: string): boolean {
    const lastTouched = new Date(lastRefreshedIso).getTime();
    const intervalMs = this.refreshIntervalDays * 24 * 60 * 60 * 1000;
    return Date.now() - lastTouched >= intervalMs;
  }

  /**
   * Runs one refresh pass over the stored index: finds posts in today's due
   * day-group that are overdue, refreshes up to `limit` of them via the API.
   * With dryRun, logs what would be refreshed but writes nothing (state file
   * is also left untouched on dry-run).
   */
  async runPass(
    limit = 150,
    dryRun = false,
  ): Promise<{ scanned: number; refreshed: number; failed: number }> {
    const state = this.loadState();
    const todayGroup = this.todaysDayGroup();
    let scanned = 0;
    let refreshed = 0;
    let failed = 0;

    const candidateIds = Object.keys(state.posts)
      .map(Number)
      .filter((id) => this.dayGroupForPostId(id) === todayGroup && this.isDue(state.posts[String(id)]));

    for (const postId of candidateIds) {
      if (refreshed >= limit) break;
      scanned++;

      let content: string;
      try {
        const post = await this.wordpress.getPostContent(postId);
        const author = await this.resolveAuthorInfo(post.author);
        const result = this.refreshContent(post.content, author);
        if (!result.changed) continue;
        content = result.content;
      } catch (err) {
        failed++;
        this.logger.warn(`Failed to fetch post ${postId}: ${(err as Error).message}`);
        continue;
      }

      if (dryRun) {
        refreshed++;
        this.logger.log(`[dry-run] Would refresh post ${postId}`);
        continue;
      }

      try {
        await this.wordpress.patchPost(postId, { content });
        state.posts[String(postId)] = new Date().toISOString();
        refreshed++;
        this.logger.log(`Refreshed post ${postId}`);
      } catch (err) {
        failed++;
        this.logger.warn(`Failed to refresh post ${postId}: ${(err as Error).message}`);
      }
    }

    if (!dryRun) this.saveState(state);

    this.logger.log(`Freshness pass done: scanned ${scanned}, refreshed ${refreshed}, failed ${failed}`);
    return { scanned, refreshed, failed };
  }
}
