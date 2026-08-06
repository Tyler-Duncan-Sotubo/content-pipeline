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
 * Deterministic 7-day bucket system: every eligible post is permanently
 * assigned to one of 7 buckets (post.id % 7). Today's bucket = the current
 * day-of-week (0=Sunday...6=Saturday) - this cron runs hourly and processes
 * up to 220 posts from today's bucket per run (same per-run pacing as the
 * main rotation), resuming where the previous hourly run left off via
 * OldPostsFreshnessService's inProgress tracking, until that day's entire
 * bucket is done. This spreads what could be a multi-thousand-post daily
 * burst across 24 hourly runs instead of one large spike, while still
 * guaranteeing every post refreshes exactly once every 7 days.
 */
@Injectable()
export class OldPostsFreshnessCronService {
  private readonly logger = new Logger(OldPostsFreshnessCronService.name);
  // Reentrancy guard: at current pacing (220 posts/run, well under a minute
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

    const today = new Date().getDay(); // 0 (Sun) - 6 (Sat), stable day-of-week bucket key
    this.logger.log(`Cron: starting old-posts freshness pass (bucket ${today})`);
    try {
      const result = await this.oldPostsFreshness.runBucket(today, 220);
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
