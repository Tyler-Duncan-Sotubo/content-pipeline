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
   * Overnight only, 01:00-05:00 Lagos, 500 posts per run.
   *
   * This rotation and the old-posts one previously both ran hourly around
   * the clock, so they competed for the same WordPress write capacity all
   * day. Splitting them by time of day keeps each one's writes off the
   * other's - and puts this one in the quietest traffic window.
   *
   * 5 runs x 500 covers the ~1,825 posts in scope comfortably (finishes in
   * about 4 runs), and at roughly 3 seconds per post a 500-post run takes
   * ~25 minutes, well inside its hour.
   *
   * Self-healing: each run only touches posts that are actually overdue, so
   * a missed run doesn't skip anything - the next one finds them still due.
   */
  @Cron("0 1-5 * * *", { name: "freshness-refresh", timeZone: "Africa/Lagos" })
  async runRefresh(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    if (this.isRunning) {
      this.logger.warn("Cron: freshness pass still running from a previous trigger - skipping");
      return;
    }
    this.isRunning = true;
    this.logger.log("Cron: starting freshness refresh pass");
    try {
      const result = await this.freshness.runPass(500);
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
