import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PipelineService } from "./pipeline.service";

/**
 * Runs both pipelines on a schedule inside this process. Only active when the
 * app is kept running (npm run start / start:dev) - a one-shot `npm run
 * pipeline` invocation exits before any cron would fire.
 */
@Injectable()
export class PipelineCronService {
  private readonly logger = new Logger(PipelineCronService.name);

  constructor(private readonly pipeline: PipelineService) {}

  // Tanzania (djmwanga.com) - 4x/day at 9am, 1pm, 5pm, 9pm WAT (Nigeria time),
  // timed around djmwanga's own posting bursts and Nigerian audience active hours.
  @Cron("0 9,13,17,21 * * *", { name: "pipeline-tz", timeZone: "Africa/Lagos" })
  async runTanzania(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    this.logger.log("Cron: starting Tanzania run");
    try {
      const summary = await this.pipeline.run();
      this.logger.log(`Cron: Tanzania run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: Tanzania run failed: ${(err as Error).message}`);
    }
  }

  // Gospel (ceenaija.com) - 3x/day at 12pm, 4pm, 8pm WAT - right after
  // ceenaija's morning posting burst, plus afternoon/evening catch-up.
  @Cron("0 12,16,20 * * *", { name: "pipeline-gospel", timeZone: "Africa/Lagos" })
  async runGospel(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    this.logger.log("Cron: starting gospel run");
    try {
      const summary = await this.pipeline.runGospel();
      this.logger.log(`Cron: gospel run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: gospel run failed: ${(err as Error).message}`);
    }
  }

  // Ghana (ghanasong.org) - 3x/day at 10am, 2pm, 7pm WAT, offset from the
  // gospel run so they don't compete for API rate limits at the same minute.
  @Cron("0 10,14,19 * * *", {
    name: "pipeline-ghana",
    timeZone: "Africa/Lagos",
  })
  async runGhana(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    this.logger.log("Cron: starting Ghana run");
    try {
      const summary = await this.pipeline.runGhana();
      this.logger.log(`Cron: Ghana run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: Ghana run failed: ${(err as Error).message}`);
    }
  }

  // Kenya (citimuzik.com) - 3x/day at 11am, 3pm, 6pm WAT, offset from the
  // other runs so no two compete for API calls at the same minute.
  @Cron("0 11,15,18 * * *", {
    name: "pipeline-kenya",
    timeZone: "Africa/Lagos",
  })
  async runKenya(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    this.logger.log("Cron: starting Kenya run");
    try {
      const summary = await this.pipeline.runKenya();
      this.logger.log(`Cron: Kenya run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: Kenya run failed: ${(err as Error).message}`);
    }
  }
}
