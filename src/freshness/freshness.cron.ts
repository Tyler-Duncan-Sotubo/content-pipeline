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

  // TEMPORARY - today only (2026-07-29): the overnight 1am-10am schedule
  // below missed most of today's runs because the freshness index was empty
  // in production (see OnApplicationBootstrap fix in freshness.service.ts),
  // so today's remaining runs are shifted to 7:45am-4:00pm to catch up
  // instead of losing the whole day. REVERT to the original 1am-10am
  // schedule (commented out below) after today.
  //
  // Original (1am-10am, restore this tomorrow):
  // @Cron("0 1 * * *", { name: "freshness-refresh-01", timeZone: "Africa/Lagos" })
  // @Cron("45 1 * * *", { name: "freshness-refresh-02", timeZone: "Africa/Lagos" })
  // @Cron("30 2 * * *", { name: "freshness-refresh-03", timeZone: "Africa/Lagos" })
  // @Cron("15 3 * * *", { name: "freshness-refresh-04", timeZone: "Africa/Lagos" })
  // @Cron("0 4 * * *", { name: "freshness-refresh-05", timeZone: "Africa/Lagos" })
  // @Cron("45 4 * * *", { name: "freshness-refresh-06", timeZone: "Africa/Lagos" })
  // @Cron("30 5 * * *", { name: "freshness-refresh-07", timeZone: "Africa/Lagos" })
  // @Cron("15 6 * * *", { name: "freshness-refresh-08", timeZone: "Africa/Lagos" })
  // @Cron("0 7 * * *", { name: "freshness-refresh-09", timeZone: "Africa/Lagos" })
  // @Cron("45 7 * * *", { name: "freshness-refresh-10", timeZone: "Africa/Lagos" })
  // @Cron("30 8 * * *", { name: "freshness-refresh-11", timeZone: "Africa/Lagos" })
  // @Cron("15 9 * * *", { name: "freshness-refresh-12", timeZone: "Africa/Lagos" })
  //
  // Today's catch-up (7:45am-4:00pm):
  @Cron("45 7 * * *", { name: "freshness-refresh-01", timeZone: "Africa/Lagos" })
  @Cron("30 8 * * *", { name: "freshness-refresh-02", timeZone: "Africa/Lagos" })
  @Cron("15 9 * * *", { name: "freshness-refresh-03", timeZone: "Africa/Lagos" })
  @Cron("0 10 * * *", { name: "freshness-refresh-04", timeZone: "Africa/Lagos" })
  @Cron("45 10 * * *", { name: "freshness-refresh-05", timeZone: "Africa/Lagos" })
  @Cron("30 11 * * *", { name: "freshness-refresh-06", timeZone: "Africa/Lagos" })
  @Cron("15 12 * * *", { name: "freshness-refresh-07", timeZone: "Africa/Lagos" })
  @Cron("0 13 * * *", { name: "freshness-refresh-08", timeZone: "Africa/Lagos" })
  @Cron("45 13 * * *", { name: "freshness-refresh-09", timeZone: "Africa/Lagos" })
  @Cron("30 14 * * *", { name: "freshness-refresh-10", timeZone: "Africa/Lagos" })
  @Cron("15 15 * * *", { name: "freshness-refresh-11", timeZone: "Africa/Lagos" })
  @Cron("0 16 * * *", { name: "freshness-refresh-12", timeZone: "Africa/Lagos" })
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
