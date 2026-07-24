import { Body, Controller, Post } from "@nestjs/common";
import { AuditService, AuditRunSummary } from "./audit.service";

@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Audit and fix existing tooxclusive posts for a list of artists.
   * POST /audit/run  { "artists": ["Ayo Maff"], "limit": 3 }
   */
  @Post("run")
  run(@Body() body: { artists?: string[]; limit?: number }): Promise<AuditRunSummary> {
    return this.audit.runAudit(body?.artists, body?.limit);
  }
}
