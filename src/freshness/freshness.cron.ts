import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { FreshnessService } from "./freshness.service";

/**
 * Two jobs:
 * - refresh pass: every 2 hours (12x/day) - reads the stored post-ID index
 *   (freshness-state.json) and only touches posts that are both in today's
 *   rotating day-group AND actually overdue (see FreshnessService), so a
 *   missed/late run doesn't skip posts: the next run just finds them still
 *   overdue and catches up.
 * - index rebuild: weekly - re-scans categories to pick up newly published
 *   posts into the index. Deliberately infrequent since it's the only part
 *   of this job that re-walks whole categories.
 */
@Injectable()
export class FreshnessCronService {
  private readonly logger = new Logger(FreshnessCronService.name);

  constructor(private readonly freshness: FreshnessService) {}

  @Cron("0 */2 * * *", { name: "freshness-refresh", timeZone: "Africa/Lagos" })
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
