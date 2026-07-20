export interface GeneratedArticle {
  title: string;
  excerpt: string;
  artist: string;
  songTitle: string;
  genre: string;
  bodyHtml: string;
  tags: string[];
}

export const articleSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "SEO-friendly article title, e.g. 'Tommy Flavour - Sijamaliza'" },
    excerpt: { type: "string", description: "Meta description, max 155 chars" },
    artist: { type: "string", description: "The artist name(s)" },
    songTitle: { type: "string", description: "The song title" },
    genre: { type: "string", description: "Genre, e.g. 'Bongo Flava / R&B'" },
    bodyHtml: {
      type: "string",
      description: "Article body as clean HTML using only <p> tags, following the required structure",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Tags: just the artist name(s) featured on the track, nothing else",
    },
  },
  required: ["title", "excerpt", "artist", "songTitle", "genre", "bodyHtml", "tags"],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You are a music journalist covering the East African / Bongo Flava music scene.
You write ORIGINAL song reviews in English. You are given the title and short description
of a newly released song. Write your own fresh review - do NOT copy the source text, and
do not fabricate specific facts (chart positions, collaborations) you were not given.

The bodyHtml MUST follow this exact structure:

1. A metadata block as one <p> with <strong> labels and <br> line breaks:
   <p><strong>Artist:</strong> ...<br><strong>Song Title:</strong> ...<br><strong>Genre:</strong> ...<br><strong>Release Date:</strong> ...</p>
2. An opening paragraph introducing the artist's return/release and the record's overall feel.
3. A paragraph on the song's meaning/title and the artist's vocal performance.
4. A paragraph on the production: instrumentation, pace, atmosphere, genre influences.
5. A closing verdict paragraph summing up the mood and who it will satisfy.
6. A final paragraph that reads exactly: <p>Stream, download, and enjoy below.</p>

Do not include a tags or credits line anywhere in the bodyHtml - tags are handled separately.

Tone: polished, warm, editorial - confident descriptions of mood and production,
like a seasoned music blog reviewer. If the release date is not given, omit that
line from the metadata block rather than inventing one.`;

export function userPrompt(post: { title: string; excerpt: string; date: string }): string {
  const released = new Date(post.date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `Write a review article for this new release.\n\nSong post title: ${post.title}\nDescription: ${post.excerpt}\nRelease date: ${released}`;
}
