import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface AuditRecord {
  auditedAt: string;
  hadIssues: boolean;
  fixesApplied: string[];
}

interface AuditState {
  audited: Record<string, AuditRecord>;
}

/**
 * Tracks which WordPress post IDs have already been audited, so the cron
 * doesn't re-check the same post every run. Separate file from state.json
 * (which tracks source-post dedup) since this tracks WP post IDs instead.
 */
@Injectable()
export class AuditStateService {
  private readonly file = join(process.cwd(), "audit-state.json");
  private readonly state: AuditState;

  constructor() {
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as AuditState)
      : { audited: {} };
  }

  isAudited(wpPostId: number): boolean {
    return String(wpPostId) in this.state.audited;
  }

  markAudited(wpPostId: number, hadIssues: boolean, fixesApplied: string[]): void {
    this.state.audited[String(wpPostId)] = {
      auditedAt: new Date().toISOString(),
      hadIssues,
      fixesApplied,
    };
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}
