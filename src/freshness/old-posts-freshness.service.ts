import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WordpressService } from "../publish/wordpress.service";
import { stripBakedAds } from "../strip-baked-ads";
import { concurrentMap } from "./concurrent-map";

/**
 * Second, independent freshness rotation for posts BELOW the main
 * FreshnessService's minPostId cutoff (default 615731) - i.e. the posts
 * excluded from the main rotation specifically because a mass post_date-
 * rewrite incident made their `date` field untrustworthy (see
 * FreshnessService's header comment for the full history).
 *
 * That incident is why those posts were excluded from freshness in the
 * first place - not because they don't deserve a freshness signal, but
 * because using the (fake) `date` to decide eligibility would have been
 * unsafe. This service sidesteps that entirely: it doesn't use `date` for
 * anything, it just tracks its OWN last-refreshed timestamp per post
 * (freshness-state-old.json), reusing the exact same visible
 * "by {author} — {date}" byline treatment as the main rotation.
 *
 * Scope: download-mp3 only, excluding Next Rated - real song-download
 * posts specifically, not news/albums/lyrics/other categories (25,277
 * posts confirmed live, vs. 37,233 across all 9 categories).
 *
 * Same interval+cap model as the main FreshnessService (not the deterministic
 * bucket-assignment system this used to run): every post overdue per
 * refreshIntervalDays is a candidate on every run, up to the per-run cap -
 * no artificial day-of-id rotation. Switched from buckets because the two
 * rotations now share a single confined overnight window (this one:
 * 04:30-07:00 Lagos, see OldPostsFreshnessCronService) instead of running
 * around the clock, so the previous "exactly once every 3 days, guaranteed"
 * bucket guarantee no longer matched reality anyway - at the smaller
 * 1,250/day capacity this window allows, the real cycle is ~20 days
 * regardless of mechanism. Interval+cap is simpler and reuses proven code
 * from FreshnessService rather than maintaining bucket logic that no
 * longer buys anything extra.
 *
 * Deliberately a SEPARATE state file and SEPARATE service instance from the
 * main FreshnessService (own state file, own category scope, own min/max
 * post-ID boundary) - the two rotations partition the whole site by post ID
 * with no gap and no overlap, but are otherwise independent.
 */
// Scoped to download-mp3 only (not the main rotation's full 9-category
// list) - per explicit decision: this rotation is specifically about real
// song-download posts, not news/albums/lyrics/etc. "Next Rated" posts are
// excluded too (confirmed live: cuts the pool from 37,233 to 25,277) since
// they're a distinct content type the site already treats separately (the
// CTA-banner content filter excludes them the same way).
const TARGET_CATEGORY_SLUG = "download-mp3";
const EXCLUDE_CATEGORY_SLUG = "next-rated";

const REFRESH_CONCURRENCY = 3;

interface OldPostsFreshnessState {
  /** Post ID -> ISO timestamp this service last refreshed it (or indexed it, if never refreshed). */
  posts: Record<string, string>;
  indexBuiltAt?: string;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

const BYLINE_MARKER_ANYWHERE_REGEX =
  /\s*<p(?:\s+style="[^"]*")?>(?:<em>)?(?:Last updated:|by\s)[\s\S]*?<\/(?:em><\/p>|p>)\s*/gi;

@Injectable()
export class OldPostsFreshnessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OldPostsFreshnessService.name);
  private readonly categoryIds: Map<string, number> = new Map();
  private readonly authorInfo: Map<number, { name: string; link: string }> = new Map();
  private readonly stateFile = join(process.cwd(), "freshness-state-old.json");
  private readonly refreshIntervalDays: number;
  // Same default cutoff as FreshnessService.minPostId - the two rotations
  // must partition the whole site with no gap and no overlap. Read from the
  // SAME env var (not a separate one) specifically so they can never drift
  // out of sync with each other.
  private readonly maxPostId: number;

  constructor(
    private readonly wordpress: WordpressService,
    config: ConfigService,
  ) {
    // At this rotation's 1,250/day capacity (5 runs x 250, 04:30-07:00
    // Lagos) against ~25,277 posts, the pool naturally cycles once every
    // ~20 days - 18 gives every post a real chance to come due each cycle
    // with a little headroom, rather than setting a shorter interval that
    // would just leave the whole pool permanently "overdue" and processing
    // order effectively arbitrary (harmless, just less intentional).
    this.refreshIntervalDays = Number(config.get("OLD_FRESHNESS_REFRESH_INTERVAL_DAYS") ?? 18);
    this.maxPostId = Number(config.get("FRESHNESS_MIN_POST_ID") ?? 615731);
  }

  /**
   * Auto-builds the index on app startup if it's empty - same reasoning as
   * FreshnessService.onApplicationBootstrap(): Railway has no persistent
   * disk, so every deploy starts from whatever freshness-state-old.json is
   * committed to git (deliberately committed empty). Without this, the
   * index would stay empty until the next daily index-build cron fires,
   * meaning up to a full day of the refresh cron doing nothing after every
   * deploy. Runs in the background so it doesn't delay app startup.
   */
  onApplicationBootstrap(): void {
    const state = this.loadState();
    if (Object.keys(state.posts).length > 0) {
      this.logger.log(`Old-posts freshness index already has ${Object.keys(state.posts).length} posts - skipping auto-build`);
      return;
    }
    this.logger.log("Old-posts freshness index is empty - auto-building on startup");
    this.buildIndex().catch((err) => {
      this.logger.error(`Old-posts startup index auto-build failed: ${(err as Error).message}`);
    });
  }

  private async resolveAuthorInfo(authorId: number): Promise<{ name: string; link: string }> {
    if (!this.authorInfo.has(authorId)) {
      const info = await this.wordpress.getUserInfo(authorId);
      this.authorInfo.set(authorId, info);
    }
    return this.authorInfo.get(authorId)!;
  }

  /**
   * Strips baked Advanced Ads placement blocks before saving - Advanced
   * Ads' own save hook re-inserts its ad block on every post update, so
   * saving content that already contains one causes it to duplicate
   * (confirmed live earlier this session on the main FreshnessService, same
   * risk applies here since this also calls patchPost() on every refresh).
   */
  private refreshContent(
    bodyHtml: string,
    author: { name: string; link: string },
  ): { content: string; changed: boolean } {
    const today = formatDate(new Date());
    const marker =
      `<p style="font-size: 0.85em; color: #777;">by ` +
      `<a href="${author.link}" style="color: #d32f2f;">${author.name}</a> — ${today}</p>\n`;
    const { content: withoutAds } = stripBakedAds(bodyHtml);
    const withoutOldMarkers = withoutAds.replace(BYLINE_MARKER_ANYWHERE_REGEX, "\n").trim();
    const updated = `${marker}${withoutOldMarkers}`;
    return { content: updated, changed: updated !== bodyHtml };
  }

  private loadState(): OldPostsFreshnessState {
    if (!existsSync(this.stateFile)) return { posts: {} };
    return JSON.parse(readFileSync(this.stateFile, "utf8")) as OldPostsFreshnessState;
  }

  private saveState(state: OldPostsFreshnessState): void {
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  /** Same merge-at-write-time pattern as FreshnessService, for the same
   * concurrent-write-safety reason (see that service's header comment). */
  private mergeAndSaveState(updates: Record<string, string>, indexBuiltAt?: string): OldPostsFreshnessState {
    const current = this.loadState();
    const merged: OldPostsFreshnessState = {
      posts: { ...current.posts, ...updates },
      indexBuiltAt: indexBuiltAt ?? current.indexBuiltAt,
    };
    this.saveState(merged);
    return merged;
  }

  private async resolveTargetCategoryId(): Promise<number | undefined> {
    if (!this.categoryIds.has(TARGET_CATEGORY_SLUG)) {
      const id = await this.wordpress.resolveCategoryIdBySlug(TARGET_CATEGORY_SLUG);
      if (id) this.categoryIds.set(TARGET_CATEGORY_SLUG, id);
    }
    return this.categoryIds.get(TARGET_CATEGORY_SLUG);
  }

  private async resolveExcludeCategoryId(): Promise<number | undefined> {
    if (!this.categoryIds.has(EXCLUDE_CATEGORY_SLUG)) {
      const id = await this.wordpress.resolveCategoryIdBySlug(EXCLUDE_CATEGORY_SLUG);
      if (id) this.categoryIds.set(EXCLUDE_CATEGORY_SLUG, id);
    }
    return this.categoryIds.get(EXCLUDE_CATEGORY_SLUG);
  }

  /**
   * Walks download-mp3 (excluding next-rated) and indexes every post with
   * id < maxPostId (the complement of the main rotation's scope). Existing
   * entries keep their last-refreshed timestamp; newly-discovered posts are
   * backdated far enough in the past to be immediately eligible - same
   * pattern as FreshnessService.buildIndex().
   */
  async buildIndex(): Promise<{ totalIndexed: number; newlyAdded: number }> {
    const existingKeys = new Set(Object.keys(this.loadState().posts));
    const categoryId = await this.resolveTargetCategoryId();
    const excludeCategoryId = await this.resolveExcludeCategoryId();
    const updates: Record<string, string> = {};
    const immediatelyEligible = new Date(
      Date.now() - (this.refreshIntervalDays + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();

    if (!categoryId) {
      this.logger.warn(`Could not resolve category "${TARGET_CATEGORY_SLUG}" - nothing to index`);
      return { totalIndexed: existingKeys.size, newlyAdded: 0 };
    }

    let page = 1;
    for (;;) {
      let posts;
      try {
        posts = excludeCategoryId
          ? await this.wordpress.listPostsByCategoryExcludingCategory(categoryId, excludeCategoryId, page, 100)
          : await this.wordpress.listPostsByCategoryNewestFirst(categoryId, page, 100);
      } catch (err) {
        if ((err as Error).message.includes("400")) break;
        throw err;
      }
      if (posts.length === 0) break;

      // Posts are returned newest-ID-first. Our scope is id < maxPostId,
      // which is the OPPOSITE end from the main rotation - so unlike that
      // service (which can stop once it crosses the boundary), we must
      // keep paging through the entire category to reach it.
      for (const post of posts) {
        if (post.id >= this.maxPostId) continue;
        const key = String(post.id);
        if (!existingKeys.has(key)) {
          updates[key] = immediatelyEligible;
        }
      }
      page++;
    }

    const newlyAdded = Object.keys(updates).length;
    const merged = this.mergeAndSaveState(updates, new Date().toISOString());
    const totalIndexed = Object.keys(merged.posts).length;
    this.logger.log(`Old-posts index built: ${totalIndexed} total posts indexed, ${newlyAdded} newly added`);
    return { totalIndexed, newlyAdded };
  }

  private isDue(lastRefreshedIso: string): boolean {
    const lastTouched = new Date(lastRefreshedIso).getTime();
    const intervalMs = this.refreshIntervalDays * 24 * 60 * 60 * 1000;
    return Date.now() - lastTouched >= intervalMs;
  }

  /**
   * Runs one refresh pass over the stored index: finds all posts that are
   * overdue (no bucket gating - every eligible post is a candidate on every
   * run), refreshes up to `limit` of them via the API. With dryRun, logs
   * what would be refreshed but writes nothing.
   */
  async runPass(
    limit = 250,
    dryRun = false,
  ): Promise<{ scanned: number; refreshed: number; failed: number }> {
    const state = this.loadState();
    let scanned = 0;
    let refreshed = 0;
    let failed = 0;
    const updates: Record<string, string> = {};

    // Sliced to `limit` up front rather than breaking out of the loop on a
    // counter: under concurrency the lanes would race on that check.
    const candidateIds = Object.keys(state.posts)
      .map(Number)
      .filter((id) => this.isDue(state.posts[String(id)]))
      .slice(0, limit);

    await concurrentMap(candidateIds, REFRESH_CONCURRENCY, async (postId) => {
      scanned++;

      let content: string;
      try {
        const post = await this.wordpress.getPostContent(postId);
        const author = await this.resolveAuthorInfo(post.author);
        const result = this.refreshContent(post.content, author);
        if (!result.changed) return;
        content = result.content;
      } catch (err) {
        failed++;
        this.logger.warn(`Failed to fetch post ${postId}: ${(err as Error).message}`);
        return;
      }

      if (dryRun) {
        refreshed++;
        this.logger.log(`[dry-run] Would refresh post ${postId}`);
        return;
      }

      try {
        await this.wordpress.patchPost(postId, { content });
        updates[String(postId)] = new Date().toISOString();
        refreshed++;
        // No per-post success line - see the equivalent note in
        // FreshnessService. The per-run summary below is the signal that
        // matters; failures are still logged individually.
      } catch (err) {
        failed++;
        this.logger.warn(`Failed to refresh post ${postId}: ${(err as Error).message}`);
      }
    });

    // Only merge in the posts THIS run actually refreshed - a concurrent
    // buildIndex() write in the meantime isn't lost.
    if (!dryRun && Object.keys(updates).length > 0) this.mergeAndSaveState(updates);

    this.logger.log(`Old-posts freshness pass done: scanned ${scanned}, refreshed ${refreshed}, failed ${failed}`);
    return { scanned, refreshed, failed };
  }
}
