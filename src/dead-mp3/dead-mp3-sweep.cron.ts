import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DeadMp3SweepService } from "./dead-mp3-sweep.service";

/**
 * Runs the dead-mp3 sweep (see DeadMp3SweepService) automatically every 5
 * minutes, all day - unlike the freshness rotations, this isn't confined
 * to an overnight window: each run only checks 50 posts (cheap GETs) and
 * only WRITES for posts that actually have a dead audio/download element,
 * which in practice is a small fraction of what's checked (2 out of 200
 * in early testing), so the write load per run is naturally light enough
 * not to need off-peak confinement.
 *
 * At 50/run x 288 runs/day = 14,400 checked/day, the ~40k-post scope (9
 * freshness categories + next-rated) sweeps in roughly 3 days. Resumable
 * via dead-mp3-sweep-state.json (shared with the manual CLI,
 * cli-strip-dead-mp3-batch.ts, which still works for ad-hoc runs) - once
 * the sweep reaches the end of the scope, runSweep() just finds 0 more
 * pages and returns checked:0 each time, so it's safe to leave running
 * indefinitely rather than needing to be turned off after the first full
 * pass.
 */
@Injectable()
export class DeadMp3SweepCronService {
  private readonly logger = new Logger(DeadMp3SweepCronService.name);
  private isRunning = false;

  constructor(private readonly sweep: DeadMp3SweepService) {}

  @Cron("*/5 * * * *", { name: "dead-mp3-sweep" })
  async runSweep(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    if (this.isRunning) {
      this.logger.warn("Cron: dead-mp3 sweep still running from a previous trigger - skipping");
      return;
    }
    this.isRunning = true;
    try {
      const result = await this.sweep.runSweep(50, true, false);
      if (result.fixed > 0) {
        // warn (not info/log) specifically so this reaches Better Stack -
        // LOGTAIL_LEVEL defaults to "warn". Gated on fixed > 0 (not just
        // checked > 0) because checked is non-zero on almost every run
        // until the whole ~40k-post scope is swept - logging THAT at warn
        // would mean 288 lines/day indefinitely, which is the same class
        // of log-volume problem that caused the Sept 1 outage. A fix is
        // rare (a handful per hundred-plus checked), so gating on it keeps
        // this line infrequent while still surfacing every real change.
        this.logger.warn(`Cron: dead-mp3 sweep done - ${JSON.stringify(result)}`);
      }
      // No line at all when fixed === 0 - the common case, deliberately
      // silent so a 5-minute cron doesn't produce constant log noise.
    } catch (err) {
      this.logger.error(`Cron: dead-mp3 sweep failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
