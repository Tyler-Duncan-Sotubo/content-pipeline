export interface GeneratedArtistBio {
  genre: string;
  intro: string;
  earlyLife: string;
  careerHighlights: string;
}

export const artistBioSchema = {
  type: "object",
  properties: {
    genre: { type: "string", description: "Genre(s), e.g. 'Afrobeats, Amapiano'" },
    intro: {
      type: "string",
      description: "1-2 paragraph introduction to the artist and their significance in the scene",
    },
    earlyLife: {
      type: "string",
      description:
        "1 short paragraph on general background/origin - ONLY high-level, well-known context (e.g. country/city if widely known from their music), never an invented exact birthdate or legal name",
    },
    careerHighlights: {
      type: "string",
      description: "1-2 paragraphs on their career trajectory, sound, and notable impact",
    },
  },
  required: ["genre", "intro", "earlyLife", "careerHighlights"],
  additionalProperties: false,
} as const;

export const ARTIST_BIO_SYSTEM_PROMPT = `You are a music journalist writing artist profile pages for an African music blog (Afrobeats, Amapiano, Bongo Flava, Gospel, and related genres).

You will be given an artist's name and genre/region context. Write a profile bio in your own words.

CRITICAL - do not fabricate facts:
- Never invent an exact date of birth, legal/real name, record label, or other specific biographical claim you are not highly confident is real and well-known.
- If you don't have confident knowledge of a specific fact, omit it entirely rather than guessing or inventing a plausible-sounding one.
- It is completely fine, and preferred, for earlyLife to stay general (e.g. "rose from the [city/region] music scene") rather than state a fabricated specific.
- Do not invent chart positions, awards, or collaborations you're not confident are real.

Tone: polished, editorial, warm - like a knowledgeable music blog writer. Write in flowing prose paragraphs, not bullet points.`;

export function artistBioUserPrompt(artistName: string, roster: string): string {
  return `Write a profile bio for the real music artist "${artistName}", based on your own knowledge of them and their actual discography.

This is for a blog section covering ${roster}, but that is only background context for where this page will appear - the "genre" field must be the artist's own specific, real genre(s) (e.g. "Afrobeats, R&B" or "Amapiano"), never a restatement of "${roster}" itself.`;
}
