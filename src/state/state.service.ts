import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface State {
  processed: Record<string, { wpPostId: number; processedAt: string }>;
}

/**
 * No-DB duplicate tracking: source post IDs we've already processed,
 * persisted to state.json in the project root. Swap for a real DB later.
 */
@Injectable()
export class StateService {
  private readonly file = join(process.cwd(), "state.json");
  private readonly state: State;

  constructor() {
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as State)
      : { processed: {} };
  }

  isProcessed(sourceId: number): boolean {
    return String(sourceId) in this.state.processed;
  }

  markProcessed(sourceId: number, wpPostId: number): void {
    this.state.processed[String(sourceId)] = {
      wpPostId,
      processedAt: new Date().toISOString(),
    };
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}
