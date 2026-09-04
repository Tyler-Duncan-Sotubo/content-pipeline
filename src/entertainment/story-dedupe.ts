/**
 * Cross-source duplicate detection for entertainment stories.
 *
 * Two sources covering the same beat will report the same event, and
 * source-ID dedupe can't see that - different sites, different IDs.
 *
 * Headline comparison does NOT work here, which is worth recording because
 * it looks like the obvious approach. Measured against real pairs, genuine
 * duplicates scored LOWER than unrelated stories:
 *
 *   0.25  SAME  "Odumodublvck makes strong vow amid Blaqbonez feud..."
 *               vs "Rift: 'I'll die for my woman' - Odumodublvck blasts..."
 *   0.44  DIFF  "Davido splurges millions on new Maybach amid family money"
 *               vs "'If e pain you...' - Davido roasts Erigga amid family money"
 *
 * The shared words in a headline are the artist names and scene vocabulary,
 * which two unrelated stories about the same person also share. Meanwhile
 * two reports of one event share little headline text, because one leads on
 * a quote and the other on a summary.
 *
 * Body/summary text works, because it describes the event itself:
 *   0.28  same story   0.04  different stories
 */

const STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by as is are was were be been " +
    "has have had his her he she they them their it its this that these those over " +
    "amid again new after before about into out up down not no you your we our us " +
    "what who how why when where which than then so if all more most some any each " +
    "other another latest says say said reveals reveal shares shared while also " +
    "being amid following ahead during since"
  ).split(" "),
);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

/** Jaccard similarity over meaningful words. */
export function storySimilarity(a: string, b: string): number {
  const A = significantWords(a);
  const B = significantWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const w of A) if (B.has(w)) intersection++;
  return intersection / (A.size + B.size - intersection);
}

export interface PublishedStory {
  artists: string[];
  summary: string;
  publishedAt: string;
}

/**
 * True if `candidate` looks like a story we've already covered.
 *
 * Scoped deliberately: only compares against stories sharing at least one
 * artist and published within `windowHours`. Without that scoping the
 * similarity score alone is too noisy to trust.
 */
export function isDuplicateStory(
  candidate: { artists: string[]; summary: string },
  published: PublishedStory[],
  opts: { threshold?: number; windowHours?: number } = {},
): { duplicate: boolean; matchedSummary?: string; score?: number } {
  const threshold = opts.threshold ?? 0.15;
  const windowMs = (opts.windowHours ?? 48) * 60 * 60 * 1000;
  const now = Date.now();
  const candidateArtists = new Set(candidate.artists.map((a) => a.toLowerCase()));

  for (const prior of published) {
    if (now - new Date(prior.publishedAt).getTime() > windowMs) continue;
    const sharesArtist = prior.artists.some((a) => candidateArtists.has(a.toLowerCase()));
    if (!sharesArtist) continue;

    const score = storySimilarity(candidate.summary, prior.summary);
    if (score >= threshold) {
      return { duplicate: true, matchedSummary: prior.summary, score };
    }
  }
  return { duplicate: false };
}
