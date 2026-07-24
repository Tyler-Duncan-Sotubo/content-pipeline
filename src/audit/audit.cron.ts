import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { AuditService } from "./audit.service";

/**
 * Audits and repairs existing tooxclusive posts (thin content, stray leaked
 * text, missing tags/meta descriptions) for a list of artists. Runs
 * independently of the content-generation crons in pipeline.cron.ts.
 */
@Injectable()
export class AuditCronService {
  private readonly logger = new Logger(AuditCronService.name);

  constructor(private readonly audit: AuditService) {}

  // Once/day at 6am WAT - light cadence since this rewrites live indexed
  // content and each fix costs an LLM call; no need to run more often.
  @Cron("0 6 * * *", { name: "audit-run", timeZone: "Africa/Lagos" })
  async run(): Promise<void> {
    this.logger.log("Cron: starting content audit run");
    try {
      const summary = await this.audit.runAudit();
      this.logger.log(`Cron: audit run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: audit run failed: ${(err as Error).message}`);
    }
  }
}
