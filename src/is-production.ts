/**
 * True only when NODE_ENV is explicitly "production" - used by every
 * @Cron handler as a second guard alongside DISABLE_CRONS, specifically so
 * running the app locally (npm run start/start:dev, where NODE_ENV is
 * normally unset or "development") never fires any scheduled job against
 * the live WordPress site by accident. DISABLE_CRONS still exists
 * separately for deliberately turning crons off IN production (e.g.
 * during an incident) without needing to change NODE_ENV.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
