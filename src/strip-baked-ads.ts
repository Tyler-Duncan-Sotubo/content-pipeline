/**
 * Shared helper: strips Advanced Ads placement blocks that get baked
 * directly into post_content on save. Used by both the one-off cleanup
 * scripts (remove-baked-ads.ts, remove-release-date.ts) and
 * FreshnessService, which must strip these before every save it makes -
 * confirmed live that Advanced Ads' save hook re-inserts its own copy on
 * every post update, so any code path that re-saves a post (ours included)
 * will duplicate an existing ad block if it isn't stripped first. Stripping
 * before save means Advanced Ads' hook always starts from a clean base and
 * only ever adds back exactly one copy, instead of compounding on every edit.
 *
 * IMPORTANT: matches ANY tooxc-{type} placement generically (before-content,
 * after-content, atf-banner, and any other type), not a hardcoded list -
 * confirmed live that an earlier version of this regex only matched
 * before/after-content and completely missed "ATF Banner" placements,
 * letting them duplicate unnoticed on every save (found post 615757 with 3x
 * duplicated atf-banner divs after being "fixed" under the old regex).
 *
 * Also handles two different closing patterns confirmed live on real posts:
 * some placements close with plain "</iframe></div>", others wrap the
 * iframe in a paragraph first - "</iframe></p>\n</div>". An earlier version
 * only matched the first pattern, silently leaving any placement of the
 * second kind (and everything after it) completely untouched.
 */
const BAKED_AD_REGEX =
  /<div id="tooxc-\d+" class="tooxc-[a-z-]+ tooxc-entity-placement[^"]*"[^>]*>[\s\S]*?<\/iframe>(?:<\/p>\s*)?<\/div>\s*/g;

export function stripBakedAds(content: string): { content: string; removed: number } {
  const matches = content.match(BAKED_AD_REGEX) ?? [];
  const cleaned = content.replace(BAKED_AD_REGEX, "");
  return { content: cleaned, removed: matches.length };
}
