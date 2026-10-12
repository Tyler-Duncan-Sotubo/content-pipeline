/**
 * Strips dead legacy MP3 download elements from post content - the actual
 * files were removed from the backend, so these are now links to nothing.
 *
 * Scoped specifically to hub.tooxclusive.com and tooxclusive.com/wp-content/
 * uploads/... hosts (confirmed dead live: both return 403 on the sampled
 * files) - NOT audio.tooxclusive.com, which is a separate, still-live host
 * serving real files (confirmed live on post 889068: a "DOWNLOAD MP3" link
 * to audio.tooxclusive.com sits right next to a working "STREAM NOW" link -
 * that pattern must be preserved, not stripped).
 *
 * Three elements removed, all confirmed on real sampled posts
 * (e.g. 252261, 58245):
 *   1. The <audio class="wp-audio-shortcode">...</audio> block - the WP
 *      [audio] shortcode's rendered output, containing a <source src=
 *      "...mp3"> and a fallback <a href="...mp3"> link inside it.
 *   2. The standalone download button paragraph, e.g.
 *      <p><strong><a href="...mp3">DOWNLOAD MP3</a></strong></p> or the
 *      looser <p><a href="...mp3"><strong>DOWNLOAD</strong></a></p> variant.
 *   3. The now-meaningless <p class="last-verified">Last verified: {date}</p>
 *      line that followed the download link (it verified a link that no
 *      longer exists).
 */
const DEAD_HOSTS_PATTERN = "(?:https?:\\/\\/)?(?:hub\\.tooxclusive\\.com|tooxclusive\\.com\\/wp-content\\/uploads)";

// <audio ...>...<source src="{dead host}...mp3...">...</audio> - matched
// non-greedily so one post's audio block doesn't swallow into the next.
// The wrapping <p>...</p> is consumed too, but the opening and closing
// wrapper tags are only ever consumed TOGETHER, as one alternative branch,
// never independently - if the audio tag is the first thing after an
// opening <p> (just whitespace allowed between them, confirmed live as the
// real pattern: "<p><audio ...>...</audio></p>"), the whole wrapper comes
// off; otherwise NEITHER wrapper tag is touched, even if a </p> happens to
// follow </audio>. Matching them independently (an earlier version of this
// regex) is a real bug: a <p> with other text before the audio tag would
// still have its TRAILING </p> eaten (nothing stopped that half), leaving
// the opening <p> orphaned with no close - confirmed via a synthetic case
// where "<p>intro text <audio>...</audio></p>" came out unbalanced.
const AUDIO_BLOCK_REGEX = new RegExp(
  `(?:\\s*<p[^>]*>\\s*<audio\\b[^>]*>(?:(?!<\\/audio>)[\\s\\S])*?${DEAD_HOSTS_PATTERN}[\\s\\S]*?<\\/audio>\\s*<\\/p>\\s*)` +
    `|(?:\\s*<audio\\b[^>]*>(?:(?!<\\/audio>)[\\s\\S])*?${DEAD_HOSTS_PATTERN}[\\s\\S]*?<\\/audio>\\s*)`,
  "gi",
);

// A block element (<p> OR a heading <h1>-<h6> - confirmed live on post
// 4868: "<h5><a href=\"...mp3\"><strong>DOWNLOAD</strong></a></h5>", not a
// <p> at all) whose only real content is a link to a dead-host .mp3
// labeled DOWNLOAD (with or without "MP3", <strong> in either order) - e.g.
// <p><strong><a href="...mp3">DOWNLOAD MP3</a></strong></p> or
// <h5><a href="...mp3"><strong>DOWNLOAD</strong></a></h5>. The backreference
// (\2) requires the closing tag to match whichever opening tag was actually
// found - a <p> can't be "closed" by </h5> or vice versa.
const DOWNLOAD_BUTTON_PARAGRAPH_REGEX = new RegExp(
  `\\s*<((p)|(h[1-6]))[^>]*>\\s*(?:<strong>)?\\s*<a\\s+href="${DEAD_HOSTS_PATTERN}[^"]*\\.mp3[^"]*"[^>]*>\\s*(?:<strong>)?\\s*DOWNLOAD(?:\\s+MP3)?\\s*(?:<\\/strong>)?\\s*<\\/a>\\s*(?:<\\/strong>)?\\s*<\\/\\1>\\s*`,
  "gi",
);

const LAST_VERIFIED_PARAGRAPH_REGEX =
  /\s*<p\s+class="last-verified"[^>]*>\s*Last verified:[^<]*<\/p>\s*/gi;

export function stripDeadMp3(
  content: string,
  /**
   * When provided, inserted as a plain link paragraph in the exact spot
   * the removed <audio> block occupied (not appended at the end) - lets a
   * caller replace the dead player with a working streaming/YouTube link
   * for the same song, found via LinksService, rather than just leaving a
   * gap. Only used if an audio block was actually found and removed;
   * ignored if the post never had one (nothing to meaningfully replace).
   */
  replacementUrl?: string,
): {
  content: string;
  removedAudio: number;
  removedDownloadButton: number;
  removedLastVerified: number;
} {
  const audioMatches = content.match(AUDIO_BLOCK_REGEX) ?? [];
  const replacement = audioMatches.length > 0 && replacementUrl ? `\n<p>${replacementUrl}</p>\n` : "\n";
  let cleaned = content.replace(AUDIO_BLOCK_REGEX, replacement);

  const downloadMatches = cleaned.match(DOWNLOAD_BUTTON_PARAGRAPH_REGEX) ?? [];
  cleaned = cleaned.replace(DOWNLOAD_BUTTON_PARAGRAPH_REGEX, "\n");

  const lastVerifiedMatches = cleaned.match(LAST_VERIFIED_PARAGRAPH_REGEX) ?? [];
  cleaned = cleaned.replace(LAST_VERIFIED_PARAGRAPH_REGEX, "\n");

  // Removing the audio/download paragraphs above can leave a stray empty
  // <p>\n</p> behind (an artifact of two adjacent block replacements
  // collapsing into each other) - clean those up too. The replacement link
  // paragraph itself (<p>{url}</p>) is never empty, so it survives this.
  cleaned = cleaned.replace(/<p>\s*<\/p>\s*/gi, "\n");

  return {
    content: cleaned.trim(),
    removedAudio: audioMatches.length,
    removedDownloadButton: downloadMatches.length,
    removedLastVerified: lastVerifiedMatches.length,
  };
}
