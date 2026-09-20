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
 * Runs 5x, every 30 minutes, 04:30-07:00 Lagos, 250 posts per run
 * (1,250/day capacity) - interval+cap model (same as the main rotation),
 * not the deterministic bucket system this used to run. Both rotations
 * used to run 500/run, old-posts spanning 06:00-00:00 - large write bursts
 * against WordPress, spread across most of the day, that were visibly
 * slowing the live site. Both are now confined to a single overnight
 * block back-to-back - main: 01:00-04:30, this one: 04:30-07:00 (see
 * FreshnessCronService) - at the smaller 250/run size, so neither one's
 * writes land during real traffic hours.
 *
 * At 1,250/day against ~25,277 posts, the pool cycles roughly once every
 * ~20 days. Self-healing: each run only touches posts that are actually
 * overdue, so a missed run doesn't skip anything - the next one finds
 * them still due.
 */
@Injectable()
export class OldPostsFreshnessCronService {
  private readonly logger = new Logger(OldPostsFreshnessCronService.name);
  // Reentrancy guard: at current pacing (250 posts/run, well under 30
  // minutes) overlap is unlikely, but a WP-side slowdown could stretch a
  // run past its slot. Without this, @nestjs/schedule would fire the next
  // trigger anyway, and two concurrent runs would race on
  // freshness-state-old.json (mergeAndSaveState prevents lost updates, but
  // not double-processing the same posts / duplicate patchPost calls).
  private isRunning = false;

  constructor(private readonly oldPostsFreshness: OldPostsFreshnessService) {}

  // 04:30, 05:00, 05:30, 06:00, 06:30 - 5 runs, stopping at 6:30 (last run
  // finishes by 7:00) so this never overlaps the main rotation's
  // 01:00-04:30 window on the other end.
  @Cron("30 4 * * *", { name: "old-posts-freshness-refresh-430", timeZone: "Africa/Lagos" })
  async runRefresh430(): Promise<void> {
    await this.runRefresh();
  }

  @Cron("0,30 5-6 * * *", { name: "old-posts-freshness-refresh-5-6", timeZone: "Africa/Lagos" })
  async runRefresh56(): Promise<void> {
    await this.runRefresh();
  }

  private async runRefresh(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    if (this.isRunning) {
      this.logger.warn("Cron: old-posts freshness pass still running from a previous trigger - skipping");
      return;
    }
    this.isRunning = true;
    this.logger.log("Cron: starting old-posts freshness refresh pass");
    try {
      const result = await this.oldPostsFreshness.runPass(250);
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
