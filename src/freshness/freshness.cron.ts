import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { FreshnessService } from "./freshness.service";

/**
 * Two jobs:
 * - refresh pass: hourly, all 24 hours (24 runs/day) - reads the stored
 *   post-ID index (freshness-state.json) and refreshes up to 60 overdue
 *   posts per run (no day-group rotation - every overdue post is a
 *   candidate every run). A missed run doesn't skip posts: the next run
 *   just finds them still overdue and catches up.
 * - index rebuild: daily - re-scans categories to pick up newly published
 *   posts into the index. Bloggers publish manually every day (not just the
 *   pipeline's own automated posts), so a new post needs same-day discovery,
 *   not up to a week's delay - buildIndex() itself is lightweight (just
 *   checks post IDs per category, no content edits), so daily is cheap.
 */
@Injectable()
export class FreshnessCronService {
  private readonly logger = new Logger(FreshnessCronService.name);
  private isRunning = false;

  constructor(private readonly freshness: FreshnessService) {}

  /**
   * Overnight only, 01:00-04:30 Lagos, every 30 minutes (8 runs), 250 posts
   * per run.
   *
   * Both rotations used to run 500/run - large write bursts against
   * WordPress that were noticeably slowing the live site during the day.
   * Cutting to 250/run halves the burst size per run; running every 30
   * minutes instead of hourly keeps total daily throughput (8 x 250 =
   * 2,000/day) well above the ~1,825-post pool, so the whole pool cycles
   * comfortably inside its 2.5-day refresh interval with headroom to spare.
   *
   * This rotation now owns 1:00-4:30am specifically so the two rotations
   * never overlap in time; old-posts owns 4:30-6:00am right after it (see
   * OldPostsFreshnessCronService). Both are now confined to the same
   * quietest overnight window instead of old-posts spilling into daytime
   * hours, which is what was causing the slowdown.
   *
   * Self-healing: each run only touches posts that are actually overdue, so
   * a missed run doesn't skip anything - the next one finds them still due.
   */
  @Cron("0,30 1-4 * * *", { name: "freshness-refresh", timeZone: "Africa/Lagos" })
  async runRefresh(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    // The 1-4 hour range with a 0,30 minute list fires at 1:00, 1:30, 2:00,
    // 2:30, 3:00, 3:30, 4:00, 4:30 - 8 runs, stopping exactly at 4:30 so
    // this never overlaps old-posts' 4:30-6:00am window.
    if (this.isRunning) {
      this.logger.warn("Cron: freshness pass still running from a previous trigger - skipping");
      return;
    }
    this.isRunning = true;
    this.logger.log("Cron: starting freshness refresh pass");
    try {
      const result = await this.freshness.runPass(250);
      this.logger.log(`Cron: freshness pass done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness pass failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  @Cron("0 5 * * *", { name: "freshness-index-build", timeZone: "Africa/Lagos" })
  async runIndexBuild(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    this.logger.log("Cron: starting freshness index build");
    try {
      const result = await this.freshness.buildIndex();
      this.logger.log(`Cron: freshness index build done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness index build failed: ${(err as Error).message}`);
    }
  }
}
