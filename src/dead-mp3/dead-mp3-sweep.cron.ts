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
      // Logged every run (not gated on fixed > 0) specifically as a
      // heartbeat - confirmed live that info-level lines DO reach Better
      // Stack fine (production's LOGTAIL_LEVEL isn't actually "warn"
      // despite that being the code's default), so there's no log-volume
      // risk here the way there would be at warn; this just confirms the
      // cron is alive and progressing even on runs where nothing matched
      // (the common case - a real fix is rare, a handful per hundred-plus
      // checked).
      this.logger.log(`Cron: dead-mp3 sweep done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: dead-mp3 sweep failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
