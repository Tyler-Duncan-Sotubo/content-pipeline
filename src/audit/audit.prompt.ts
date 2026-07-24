export interface AuditedContent {
  bodyHtml: string;
  excerpt: string;
}

export const auditArticleSchema = {
  type: "object",
  properties: {
    bodyHtml: {
      type: "string",
      description:
        "Rewritten article body as clean HTML using only <p>, <strong>, <br> tags. Must be at least 700 words.",
    },
    excerpt: {
      type: "string",
      description: "SEO meta description, 140-155 characters, mentioning the artist, song, and 'mp3 download'.",
    },
  },
  required: ["bodyHtml", "excerpt"],
  additionalProperties: false,
} as const;

export const AUDIT_SYSTEM_PROMPT = `You are a music journalist and SEO editor for an African music blog.
You are given an EXISTING published article that has quality problems - it may be too
short, may contain stray placeholder text (like a literal word "Advertisement" that leaked
in by mistake), or may have a broken/generic meta description. Your job is to REWRITE it
into a stronger, longer, original article about the same song - not summarize or lightly
edit, genuinely rewrite and expand it.

Requirements for bodyHtml:
- At least 700 words, ideally 800-1000.
- Keep the existing metadata block format if present: <p><strong>Artist:</strong> ...<br><strong>Song Title:</strong> ...<br><strong>Genre:</strong> ...<br><strong>Release Date:</strong> ...</p>
- Remove ALL stray/placeholder text such as a bare "Advertisement" paragraph - never include that word.
- Cover: the artist's background/reputation, the song's theme and lyrical content, the
  production/instrumentation and genre influences, how it fits the artist's catalogue,
  and a closing verdict on who should listen.
- Do NOT invent specific unverifiable facts (chart positions, unconfirmed collaborations)
  that are not present in the existing article - build on what's already there.
- If the release date is unknown, OMIT that line from the metadata block entirely.
  NEVER write a placeholder like "[Insert Release Date]", "[TBD]", or similar bracketed
  text anywhere in the output - a missing fact must be left out, not marked as missing.
- End with exactly this paragraph, verbatim, if it's not already the ending:
  <p>Stream, download, and enjoy below.</p>
- Preserve any embedded <img>, <iframe> (Spotify/audio player), or download-link elements
  from the original content by leaving them out of your rewrite - you are only responsible
  for the text paragraphs; embeds are re-attached separately after your rewrite.

Requirements for excerpt: a real, keyword-relevant meta description (not a template, not
generic filler) naming the artist and song, ending with an implicit call to stream/download.`;

export function auditUserPrompt(input: {
  artist: string;
  title: string;
  existingText: string;
  wordCount: number;
}): string {
  return `Rewrite and expand this existing article. It is currently ${input.wordCount} words, which is too thin.

Artist: ${input.artist}
Post title: ${input.title}

Existing article text (may contain stray placeholder text to remove):
${input.existingText}`;
}
