import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DeadMp3SweepService } from "./dead-mp3-sweep.service";

/**
 * Runs the dead-mp3 sweep (see DeadMp3SweepService) automatically every 5
 * minutes, at 200 posts/run - 57,600 checked/day, sweeping the ~40k-post
 * scope in under a day.
 *
 * Gated on its OWN explicit opt-in, DEAD_MP3_SWEEP_CRON_ENABLED, rather
 * than DISABLE_CRONS (a blanket kill-switch for every cron in the app) or
 * NODE_ENV/isProduction() (which every OTHER cron checks) - this one was
 * briefly dropped from production entirely (its logs weren't initially
 * showing up as expected in Better Stack - root cause turned out to be
 * that this exact env var wasn't declared in env.validation.ts, so
 * NestJS's ConfigModule was silently stripping it before it ever reached
 * process.env; fixed there) and needs to be re-enabled independently of
 * every other cron's gate, both to turn back on and to turn back off
 * again if needed without touching anything else.
 *
 * Set DEAD_MP3_SWEEP_CRON_ENABLED=true on Railway for this to actually
 * run in production - the env var alone (declared in the schema now) is
 * what decides it, this code doesn't otherwise distinguish environments.
 */
@Injectable()
export class DeadMp3SweepCronService {
  private readonly logger = new Logger(DeadMp3SweepCronService.name);
  private isRunning = false;

  constructor(private readonly sweep: DeadMp3SweepService) {}

  @Cron("*/5 * * * *", { name: "dead-mp3-sweep" })
  async runSweep(): Promise<void> {
    // Hard off by default - see header comment. Not gated on
    // DISABLE_CRONS/isProduction() like the other crons; this one needs
    // its OWN explicit opt-in regardless of environment.
    if (process.env.DEAD_MP3_SWEEP_CRON_ENABLED !== "true") return;

    if (this.isRunning) {
      this.logger.warn("Cron: dead-mp3 sweep still running from a previous trigger - skipping");
      return;
    }
    this.isRunning = true;
    try {
      // 200/run (bumped from 50) - at every-5-min cadence that's
      // 57,600/day, sweeping the ~40k-post scope in under a day.
      const result = await this.sweep.runSweep(200, true, false);
      this.logger.log(`Cron: dead-mp3 sweep done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: dead-mp3 sweep failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
