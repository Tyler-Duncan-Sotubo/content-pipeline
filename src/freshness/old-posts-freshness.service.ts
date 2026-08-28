import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WordpressService } from "../publish/wordpress.service";
import { stripBakedAds } from "../strip-baked-ads";

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
 * anything, it just walks every eligible post below the cutoff and puts it
 * in a DETERMINISTIC bucket (post.id % 3), reusing the exact same visible
 * "by {author} — {date}" byline treatment as the main rotation.
 *
 * Scope: download-mp3 only, excluding Next Rated - real song-download
 * posts specifically, not news/albums/lyrics/other categories (25,277
 * posts confirmed live, vs. 37,233 across all 9 categories).
 *
 * Deterministic buckets (not "refresh whatever's overdue, capped at N/run"):
 * every post is assigned to exactly one of 3 buckets (0-2) permanently, once,
 * based on its own ID - never reassigned. A daily cron runs ONLY today's
 * bucket (a repeating day-index mod 3, NOT day-of-week - 3 doesn't evenly
 * divide a 7-day week, so the mapping deliberately uses a day-of-epoch
 * count instead), refreshing up to a per-run cap from it. This guarantees
 * each post refreshes exactly once every 3 days, no more, no less - unlike
 * an interval+cap system, which can silently under-rotate if the eligible
 * pool ever exceeds cap*runs_per_interval.
 *
 * Deliberately a SEPARATE state file and SEPARATE mechanism from the main
 * FreshnessService, per explicit instruction not to change the existing
 * rotation's behavior at all - this is purely additive.
 */
// Scoped to download-mp3 only (not the main rotation's full 9-category
// list) - per explicit decision: this rotation is specifically about real
// song-download posts, not news/albums/lyrics/etc. "Next Rated" posts are
// excluded too (confirmed live: cuts the pool from 37,233 to 25,277) since
// they're a distinct content type the site already treats separately (the
// CTA-banner content filter excludes them the same way).
const TARGET_CATEGORY_SLUG = "download-mp3";
const EXCLUDE_CATEGORY_SLUG = "next-rated";

const BUCKET_COUNT = 3;

interface OldPostsFreshnessState {
  /** Post ID (string) -> its permanent bucket assignment (0-2). Never reassigned once set. */
  buckets: Record<string, number>;
  /** Post ID -> ISO timestamp last refreshed (for observability only, not used to decide eligibility). */
  lastRefreshed: Record<string, string>;
  /**
   * Which bucket number is currently "in progress" for today, and the set of
   * post IDs within it already done - lets an hourly cron process a day's
   * bucket gradually (capped per run) across many calls instead of all at
   * once, while still guaranteeing every post in the bucket gets refreshed
   * before the day ends. Reset (cleared + reseeded) whenever the day's
   * bucket number changes.
   */
  inProgress?: {
    bucket: number;
    /** Post IDs from this bucket not yet refreshed today. */
    remaining: number[];
  };
  indexBuiltAt?: string;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

const BYLINE_MARKER_ANYWHERE_REGEX =
  /\s*<p(?:\s+style="[^"]*")?>(?:<em>)?(?:Last updated:|by\s)[\s\S]*?<\/(?:em><\/p>|p>)\s*/gi;

/** Deterministic, permanent bucket assignment - pure function of the post ID. */
export function bucketForPostId(postId: number): number {
  return postId % BUCKET_COUNT;
}

@Injectable()
export class OldPostsFreshnessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OldPostsFreshnessService.name);
  private readonly categoryIds: Map<string, number> = new Map();
  private readonly authorInfo: Map<number, { name: string; link: string }> = new Map();
  private readonly stateFile = join(process.cwd(), "freshness-state-old.json");
  // Same default cutoff as FreshnessService.minPostId - the two rotations
  // must partition the whole site with no gap and no overlap. Read from the
  // SAME env var (not a separate one) specifically so they can never drift
  // out of sync with each other.
  private readonly maxPostId: number;

  constructor(
    private readonly wordpress: WordpressService,
    config: ConfigService,
  ) {
    this.maxPostId = Number(config.get("FRESHNESS_MIN_POST_ID") ?? 615731);
  }

  /**
   * Auto-builds the index on app startup if it's empty - same reasoning as
   * FreshnessService.onApplicationBootstrap(): Railway has no persistent
   * disk, so every deploy starts from whatever freshness-state-old.json is
   * committed to git (deliberately committed empty). Without this, the
   * index would stay empty until the next daily 6am index-build cron fires,
   * meaning up to a full day of the hourly refresh cron doing nothing after
   * every deploy. Runs in the background so it doesn't delay app startup.
   */
  onApplicationBootstrap(): void {
    const state = this.loadState();
    if (Object.keys(state.buckets).length > 0) {
      this.logger.log(`Old-posts freshness index already has ${Object.keys(state.buckets).length} posts - skipping auto-build`);
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
    if (!existsSync(this.stateFile)) return { buckets: {}, lastRefreshed: {} };
    return JSON.parse(readFileSync(this.stateFile, "utf8")) as OldPostsFreshnessState;
  }

  private saveState(state: OldPostsFreshnessState): void {
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  /** Same merge-at-write-time pattern as FreshnessService, for the same
   * concurrent-write-safety reason (see that service's header comment). */
  private mergeAndSaveState(
    bucketUpdates: Record<string, number>,
    lastRefreshedUpdates: Record<string, string>,
    options?: { indexBuiltAt?: string; inProgress?: OldPostsFreshnessState["inProgress"] },
  ): OldPostsFreshnessState {
    const current = this.loadState();
    const merged: OldPostsFreshnessState = {
      buckets: { ...current.buckets, ...bucketUpdates },
      lastRefreshed: { ...current.lastRefreshed, ...lastRefreshedUpdates },
      indexBuiltAt: options?.indexBuiltAt ?? current.indexBuiltAt,
      inProgress: options && "inProgress" in options ? options.inProgress : current.inProgress,
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
   * Walks download-mp3 (excluding next-rated) and assigns every post with
   * id < maxPostId (the complement of the main rotation's scope) to its
   * permanent bucket (post.id % 3). Existing assignments are never changed -
   * only genuinely new-to-the-index posts get a bucket assigned.
   */
  async buildIndex(): Promise<{ totalIndexed: number; newlyAdded: number }> {
    const existingKeys = new Set(Object.keys(this.loadState().buckets));
    const categoryId = await this.resolveTargetCategoryId();
    const excludeCategoryId = await this.resolveExcludeCategoryId();
    const bucketUpdates: Record<string, number> = {};

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
          bucketUpdates[key] = bucketForPostId(post.id);
        }
      }
      page++;
    }

    const newlyAdded = Object.keys(bucketUpdates).length;
    const merged = this.mergeAndSaveState(bucketUpdates, {}, { indexBuiltAt: new Date().toISOString() });
    const totalIndexed = Object.keys(merged.buckets).length;
    this.logger.log(`Old-posts index built: ${totalIndexed} total posts indexed, ${newlyAdded} newly added`);
    return { totalIndexed, newlyAdded };
  }

  /**
   * Processes up to `limit` posts from today's bucket, resuming across calls
   * via state.inProgress so an hourly cron can spread a whole bucket's
   * membership (potentially thousands of posts) across many runs during the
   * day, instead of writing them all in one burst - same per-run pacing as
   * the main FreshnessService's hourly rotation, gentler on the origin
   * server. Guarantees exactly-once-per-3-days regardless of how many hourly
   * calls it takes: the bucket assignment never changes, and inProgress
   * tracks exactly which of today's bucket members are still outstanding,
   * so a missed hour or a restart never skips or duplicates a post within
   * the same day's bucket.
   *
   * When `bucket` differs from the bucket already in progress (i.e. it's a
   * new day), inProgress is reset to the full membership of the new bucket -
   * whatever was left unfinished from the previous day's bucket is simply
   * abandoned for this cycle (it'll get its turn again in exactly 3 days,
   * same as every other post - a missed/incomplete day doesn't compound).
   */
  async runBucket(
    bucket: number,
    limit = 360,
    dryRun = false,
  ): Promise<{ scanned: number; refreshed: number; failed: number; remainingInBucket: number }> {
    if (bucket < 0 || bucket >= BUCKET_COUNT) {
      throw new Error(`Invalid bucket ${bucket} - must be 0-${BUCKET_COUNT - 1}`);
    }

    const state = this.loadState();
    let remaining: number[];

    if (state.inProgress && state.inProgress.bucket === bucket) {
      remaining = state.inProgress.remaining;
    } else {
      // New day (or first run ever) - reseed with the full bucket membership.
      remaining = Object.keys(state.buckets)
        .map(Number)
        .filter((id) => state.buckets[String(id)] === bucket);
      this.logger.log(`Old-posts bucket ${bucket} is now today's bucket - seeded ${remaining.length} posts`);
    }

    const toProcess = remaining.slice(0, limit);
    const stillRemaining = remaining.slice(limit);

    let scanned = 0;
    let refreshed = 0;
    let failed = 0;
    const lastRefreshedUpdates: Record<string, string> = {};
    const doneThisRun: number[] = [];

    for (const postId of toProcess) {
      scanned++;

      let content: string;
      try {
        const post = await this.wordpress.getPostContent(postId);
        const author = await this.resolveAuthorInfo(post.author);
        const result = this.refreshContent(post.content, author);
        if (!result.changed) {
          doneThisRun.push(postId);
          continue;
        }
        content = result.content;
      } catch (err) {
        failed++;
        this.logger.warn(`Failed to fetch post ${postId}: ${(err as Error).message}`);
        // Not marked done - will be retried on the next hourly call within
        // the same day's bucket, since it's still in `remaining` minus
        // whatever WAS successfully processed (doneThisRun).
        continue;
      }

      if (dryRun) {
        refreshed++;
        this.logger.log(`[dry-run] Would refresh post ${postId} (bucket ${bucket})`);
        continue;
      }

      try {
        await this.wordpress.patchPost(postId, { content });
        lastRefreshedUpdates[String(postId)] = new Date().toISOString();
        refreshed++;
        doneThisRun.push(postId);
        this.logger.log(`Refreshed post ${postId} (bucket ${bucket})`);
      } catch (err) {
        failed++;
        this.logger.warn(`Failed to refresh post ${postId}: ${(err as Error).message}`);
      }
    }

    if (!dryRun) {
      const failedIds = new Set(toProcess.filter((id) => !doneThisRun.includes(id)));
      const newRemaining = [...stillRemaining, ...failedIds];
      this.mergeAndSaveState(
        {},
        lastRefreshedUpdates,
        { inProgress: { bucket, remaining: newRemaining } },
      );
    }

    this.logger.log(
      `Old-posts bucket ${bucket} pass done: scanned ${scanned}, refreshed ${refreshed}, failed ${failed}, ` +
        `${stillRemaining.length} left for later runs today`,
    );
    return { scanned, refreshed, failed, remainingInBucket: stillRemaining.length };
  }

  /** Distribution snapshot - how many posts are in each bucket right now. Useful for verifying accuracy before/after a production rollout. */
  getBucketDistribution(): Record<number, number> {
    const state = this.loadState();
    const distribution: Record<number, number> = {};
    for (let i = 0; i < BUCKET_COUNT; i++) distribution[i] = 0;
    for (const bucket of Object.values(state.buckets)) {
      distribution[bucket] = (distribution[bucket] ?? 0) + 1;
    }
    return distribution;
  }
}
