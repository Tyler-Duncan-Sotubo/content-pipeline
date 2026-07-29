import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { FreshnessService } from "./freshness.service";

/**
 * Two jobs:
 * - refresh pass: hourly, 8am-4pm WAT (9 runs/day) - reads the stored
 *   post-ID index (freshness-state.json) and only touches posts that are
 *   both in today's rotating day-group AND actually overdue (see
 *   FreshnessService), so a missed/late run doesn't skip posts: the next
 *   run just finds them still overdue and catches up.
 * - index rebuild: daily - re-scans categories to pick up newly published
 *   posts into the index. Bloggers publish manually every day (not just the
 *   pipeline's own automated posts), so a new post needs same-day discovery,
 *   not up to a week's delay - buildIndex() itself is lightweight (just
 *   checks post IDs per category, no content edits), so daily is cheap.
 */
@Injectable()
export class FreshnessCronService {
  private readonly logger = new Logger(FreshnessCronService.name);

  constructor(private readonly freshness: FreshnessService) {}

  // Simple hourly schedule, 8am-4pm WAT (9 runs/day) - the previous 45-min-
  // interval, 12-entry version was harder to reason about and one slot
  // (8:00am) silently didn't fire as expected. One cron expression, on the
  // hour, is simpler to verify and debug. Self-healing either way: each run
  // only touches posts that are both in today's rotating day-group AND
  // actually overdue (see FreshnessService), so a missed run doesn't skip
  // posts - the next run just finds them still overdue and catches up.
  @Cron("0 8-16 * * *", { name: "freshness-refresh", timeZone: "Africa/Lagos" })
  async runRefresh(): Promise<void> {
    this.logger.log("Cron: starting freshness refresh pass");
    try {
      const result = await this.freshness.runPass(150);
      this.logger.log(`Cron: freshness pass done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness pass failed: ${(err as Error).message}`);
    }
  }

  @Cron("0 5 * * *", { name: "freshness-index-build", timeZone: "Africa/Lagos" })
  async runIndexBuild(): Promise<void> {
    this.logger.log("Cron: starting freshness index build");
    try {
      const result = await this.freshness.buildIndex();
      this.logger.log(`Cron: freshness index build done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness index build failed: ${(err as Error).message}`);
    }
  }
}
