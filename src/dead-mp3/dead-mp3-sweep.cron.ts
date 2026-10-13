import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DeadMp3SweepService } from "./dead-mp3-sweep.service";

/**
 * Was going to run the dead-mp3 sweep (see DeadMp3SweepService)
 * automatically every 5 minutes - DROPPED FROM PRODUCTION per explicit
 * decision (its fix/heartbeat logs weren't showing up as expected in
 * Better Stack, and the sweep is being run manually/locally instead for
 * now). Hard-disabled below rather than removed, so the module and
 * DeadMp3SweepService stay available for the manual CLI tools
 * (cli-strip-dead-mp3.ts, cli-strip-dead-mp3-batch.ts), which still work
 * exactly as before - only THIS automatic cron trigger is off.
 *
 * DEAD_MP3_SWEEP_CRON_ENABLED must be explicitly set to "true" to turn
 * this back on (e.g. once the logging/visibility question is resolved) -
 * intentionally a separate switch from DISABLE_CRONS (which is a blanket
 * kill-switch for every cron in the app) and from NODE_ENV/isProduction()
 * (which every OTHER cron now also checks), so this one can be re-enabled
 * independently without touching anything else.
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
      const result = await this.sweep.runSweep(50, true, false);
      this.logger.log(`Cron: dead-mp3 sweep done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: dead-mp3 sweep failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
