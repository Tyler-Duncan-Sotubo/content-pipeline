/**
 * Shared helper: strips Advanced Ads "Before Content"/"After Content" blocks
 * that get baked directly into post_content on save. Used by both the
 * one-off cleanup script (remove-baked-ads.ts) and FreshnessService, which
 * must strip these before every save it makes - confirmed live that
 * Advanced Ads' save hook re-inserts its own copy on every post update, so
 * any code path that re-saves a post (ours included) will duplicate an
 * existing ad block if it isn't stripped first. Stripping before save means
 * Advanced Ads' hook always starts from a clean base and only ever adds
 * back exactly one copy, instead of compounding on every edit.
 */
const BAKED_AD_REGEX =
  /<div id="tooxc-\d+" class="tooxc-(?:before|after)-content[^"]*"[^>]*>[\s\S]*?<\/iframe><\/div>\s*/g;

export function stripBakedAds(content: string): { content: string; removed: number } {
  const matches = content.match(BAKED_AD_REGEX) ?? [];
  const cleaned = content.replace(BAKED_AD_REGEX, "");
  return { content: cleaned, removed: matches.length };
}
