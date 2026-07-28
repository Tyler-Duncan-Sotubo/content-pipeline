import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { FreshnessService } from "./freshness.service";

/**
 * Two jobs:
 * - refresh pass: 12x/day, every 45 minutes between 1am-10am WAT (lowest-
 *   traffic overnight window) instead of spread across all 24 hours - same
 *   total daily volume, concentrated when fewer visitors are around. Reads
 *   the stored post-ID index (freshness-state.json) and only touches posts
 *   that are both in today's rotating day-group AND actually overdue (see
 *   FreshnessService), so a missed/late run doesn't skip posts: the next
 *   run just finds them still overdue and catches up.
 * - index rebuild: weekly - re-scans categories to pick up newly published
 *   posts into the index. Deliberately infrequent since it's the only part
 *   of this job that re-walks whole categories.
 */
@Injectable()
export class FreshnessCronService {
  private readonly logger = new Logger(FreshnessCronService.name);

  constructor(private readonly freshness: FreshnessService) {}

  // 45-min cadence isn't expressible as a single cron field (60 isn't evenly
  // divisible by 45), so each of the 12 run times - 1:00, 1:45, 2:30, 3:15,
  // 4:00, 4:45, 5:30, 6:15, 7:00, 7:45, 8:30, 9:15 - is listed explicitly.
  @Cron("0 1 * * *", { name: "freshness-refresh-01", timeZone: "Africa/Lagos" })
  @Cron("45 1 * * *", { name: "freshness-refresh-02", timeZone: "Africa/Lagos" })
  @Cron("30 2 * * *", { name: "freshness-refresh-03", timeZone: "Africa/Lagos" })
  @Cron("15 3 * * *", { name: "freshness-refresh-04", timeZone: "Africa/Lagos" })
  @Cron("0 4 * * *", { name: "freshness-refresh-05", timeZone: "Africa/Lagos" })
  @Cron("45 4 * * *", { name: "freshness-refresh-06", timeZone: "Africa/Lagos" })
  @Cron("30 5 * * *", { name: "freshness-refresh-07", timeZone: "Africa/Lagos" })
  @Cron("15 6 * * *", { name: "freshness-refresh-08", timeZone: "Africa/Lagos" })
  @Cron("0 7 * * *", { name: "freshness-refresh-09", timeZone: "Africa/Lagos" })
  @Cron("45 7 * * *", { name: "freshness-refresh-10", timeZone: "Africa/Lagos" })
  @Cron("30 8 * * *", { name: "freshness-refresh-11", timeZone: "Africa/Lagos" })
  @Cron("15 9 * * *", { name: "freshness-refresh-12", timeZone: "Africa/Lagos" })
  async runRefresh(): Promise<void> {
    this.logger.log("Cron: starting freshness refresh pass");
    try {
      const result = await this.freshness.runPass(150);
      this.logger.log(`Cron: freshness pass done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness pass failed: ${(err as Error).message}`);
    }
  }

  @Cron("0 5 * * 0", { name: "freshness-index-build", timeZone: "Africa/Lagos" })
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
