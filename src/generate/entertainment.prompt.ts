export interface GeneratedEntertainmentPost {
  title: string;
  excerpt: string;
  artists: string[];
  subheading: string;
  introParagraphs: string[];
  bodyParagraphs: string[];
  closingParagraph: string;
  tags: string[];
}

export const entertainmentSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "Original SEO headline, 55-70 characters. MUST be substantially reworded from the source headline - " +
        "not a copy or light paraphrase. Lead with the artist name(s). Plain, factual and searchable rather " +
        "than clickbait, e.g. 'Davido Responds To Erigga In Family Money Debate'.",
    },
    excerpt: {
      type: "string",
      description: "Meta description, max 155 characters. Summarises what actually happened, names the artist(s).",
    },
    artists: {
      type: "array",
      items: { type: "string" },
      description: "Only artist names that genuinely appear in the source story.",
    },
    subheading: {
      type: "string",
      description:
        "A single <h2> heading for mid-article, 4-9 words, keyword-rich and containing an artist name, " +
        "e.g. 'Davido Hits Back At Family Money Claims'. Must be a statement, not a question.",
    },
    introParagraphs: {
      type: "array",
      items: { type: "string" },
      description: "2-3 short opening paragraphs (25-45 words each) covering what happened and the context.",
    },
    bodyParagraphs: {
      type: "array",
      items: { type: "string" },
      description:
        "3-4 paragraphs (30-80 words each) giving detail. Any quotation MUST be reproduced word-for-word " +
        "from the source and attributed to the person who said it.",
    },
    closingParagraph: {
      type: "string",
      description: "One short forward-looking closing paragraph (20-40 words).",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Artist names featured in the story, nothing else.",
    },
  },
  required: [
    "title",
    "excerpt",
    "artists",
    "subheading",
    "introParagraphs",
    "bodyParagraphs",
    "closingParagraph",
    "tags",
  ],
  additionalProperties: false,
} as const;

/**
 * These posts restate another outlet's reporting about named, real people,
 * and they publish automatically with no human review. So the prompt's job
 * is mostly restraint: report only what the source reported, quote exactly,
 * and never upgrade a rumour into a fact.
 */
export const ENTERTAINMENT_SYSTEM_PROMPT = `You are an entertainment reporter covering Afrobeats and the Nigerian music scene.
You are given a source article. Write an ORIGINAL report of the same story in your own words.

ABSOLUTE RULES - these exist because the story concerns real, named people:

1. Report ONLY what the source article states. Never add background, motives,
   history, reactions or context that is not in the source.
2. Reproduce every quotation EXACTLY as it appears in the source, and attribute
   it to the person the source attributes it to. Never invent or reword a quote.
3. Preserve the source's certainty. If it says "reportedly", "allegedly" or
   "appeared to", keep that hedging. Never state a rumour or claim as fact.
4. Never speculate about anyone's relationships, finances, health, legal
   situation or motives.
5. Do not editorialise or take a side in a dispute. Report what each person said.
6. If the source is thin, write a shorter piece. Never pad with invention.

STYLE:
- Short paragraphs, plain factual sentences, no hype.
- The TITLE must be substantially different in wording from the source headline
  while describing the same event - this is a hard requirement, not a preference.
- Lead the title with the artist name so it is searchable.
- Write in English. Preserve Nigerian Pidgin exactly as-is inside quotations.`;

export function entertainmentUserPrompt(params: {
  sourceTitle: string;
  sourceBody: string;
  matchedArtists: string[];
}): string {
  return `SOURCE HEADLINE: ${params.sourceTitle}

SOURCE ARTICLE:
${params.sourceBody}

ARTISTS THIS STORY IS ABOUT: ${params.matchedArtists.join(", ")}

Write an original report of this story. The title must be clearly reworded from
the source headline above. Quote exactly; add nothing that is not in the source.`;
}
