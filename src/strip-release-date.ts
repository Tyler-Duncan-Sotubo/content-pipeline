/**
 * Removes the static "Release Date: {date}" line from a post's metadata
 * block. This line was baked into post_content at generation time by the
 * old article prompt (see article.prompt.ts) and never updated afterward -
 * a stale fact sitting next to the freshness signals we actively keep
 * current (byline, WP dateModified, Rank Math schema). New articles no
 * longer generate this line at all; this strips it from posts that already
 * have it.
 *
 * Matches real HTML variability confirmed live across different posts (some
 * LLM outputs add data-start/data-end attributes to <br>/<strong> tags) -
 * removes the preceding <br ...> plus the Release Date <strong>...</strong>
 * and its date text, up to (but not including) the closing </p>, so
 * whatever field comes before Release Date (Genre, possibly already linked
 * to a category) becomes the new last field in the metadata block.
 */
const RELEASE_DATE_REGEX =
  /\s*<br[^>]*>\s*<strong[^>]*>Release Date:<\/strong>[^<]*(?=<\/p>)/gi;

export function stripReleaseDate(content: string): { content: string; removed: number } {
  const matches = content.match(RELEASE_DATE_REGEX) ?? [];
  const cleaned = content.replace(RELEASE_DATE_REGEX, "");
  return { content: cleaned, removed: matches.length };
}
