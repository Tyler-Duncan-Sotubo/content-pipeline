import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { OldPostsFreshnessService } from "./old-posts-freshness.service";

/**
 * Second, independent freshness rotation for posts below the main
 * FreshnessService's minPostId cutoff (615731) - see
 * OldPostsFreshnessService's header comment for why these were previously
 * excluded from freshness entirely, and why that exclusion doesn't need to
 * mean "no freshness signal ever."
 *
 * Deterministic 3-day bucket system: every eligible post is permanently
 * assigned to one of 3 buckets (post.id % 3). Today's bucket = a
 * continuously-incrementing day-of-epoch counter mod 3 - NOT day-of-week
 * (getDay() is 0-6 and doesn't evenly divide into 3 buckets, which would
 * make some buckets run on 2 days out of every 7 and others on fewer,
 * breaking the "exactly once every 3 days" guarantee). The epoch-day
 * counter increments by exactly 1 every calendar day forever, so bucket 0,
 * 1, 2, 0, 1, 2... cycles with true 3-day regularity regardless of what
 * day-of-week or month it lands on.
 *
 * This cron runs hourly and processes up to 360 posts from today's bucket
 * per run (~8,426 posts/bucket ÷ 24 hourly runs ≈ 351 needed, so 360 gives
 * headroom to reliably finish within the day) - same resumable-across-runs
 * approach as before via OldPostsFreshnessService's inProgress tracking,
 * spreading what could be a multi-thousand-post daily burst across 24
 * hourly runs instead of one large spike, while still guaranteeing every
 * post refreshes exactly once every 3 days.
 */
@Injectable()
export class OldPostsFreshnessCronService {
  private readonly logger = new Logger(OldPostsFreshnessCronService.name);
  // Reentrancy guard: at current pacing (360 posts/run, well under a minute
  // in practice) overlap is very unlikely, but a WP-side slowdown could
  // stretch a run past the hour. Without this, @nestjs/schedule would fire
  // the next hourly trigger anyway, and two concurrent runs would race on
  // freshness-state-old.json (mergeAndSaveState prevents lost updates, but
  // not double-processing the same posts / duplicate patchPost calls).
  private isRunning = false;

  constructor(private readonly oldPostsFreshness: OldPostsFreshnessService) {}

  @Cron("0 * * * *", { name: "old-posts-freshness-refresh", timeZone: "Africa/Lagos" })
  async runRefresh(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;

    if (this.isRunning) {
      this.logger.warn("Cron: old-posts freshness pass still running from a previous trigger - skipping this run");
      return;
    }
    this.isRunning = true;

    // Days since the Unix epoch, mod 3 - increments by exactly 1 every
    // calendar day (UTC), giving a true 3-day-regular cycle 0,1,2,0,1,2...
    // unlike day-of-week (0-6), which doesn't divide evenly into 3 buckets.
    const epochDay = Math.floor(Date.now() / 86_400_000);
    const todaysBucket = epochDay % 3;
    this.logger.log(`Cron: starting old-posts freshness pass (bucket ${todaysBucket})`);
    try {
      const result = await this.oldPostsFreshness.runBucket(todaysBucket, 360);
      this.logger.log(`Cron: old-posts freshness pass done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: old-posts freshness pass failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  @Cron("0 6 * * *", { name: "old-posts-freshness-index-build", timeZone: "Africa/Lagos" })
  async runIndexBuild(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    this.logger.log("Cron: starting old-posts freshness index build");
    try {
      const result = await this.oldPostsFreshness.buildIndex();
      this.logger.log(`Cron: old-posts freshness index build done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: old-posts freshness index build failed: ${(err as Error).message}`);
    }
  }
}
