export interface DiscographyAlbum {
  title: string;
  year: string;
  tracks: string[];
}

export interface GeneratedArtistBio {
  realName: string;
  aliasName: string;
  dateOfBirth: string;
  hometown: string;
  label: string;
  genre: string;
  bioHtml: string;
  discography: DiscographyAlbum[];
}

export const artistBioSchema = {
  type: "object",
  properties: {
    realName: {
      type: "string",
      description:
        "Real/legal name if genuinely well-known and public (e.g. from press/Wikipedia-level common knowledge). Empty string if not confidently known.",
    },
    aliasName: {
      type: "string",
      description: "Known nickname(s)/alias(es), empty string if none well-known",
    },
    dateOfBirth: {
      type: "string",
      description:
        "Date of birth in 'Month D, YYYY' format if genuinely well-known public info. Empty string if not confidently known - do not guess.",
    },
    hometown: { type: "string", description: "City/region, State/Country - empty string if not confidently known" },
    label: { type: "string", description: "Record label(s), empty string if not confidently known" },
    genre: { type: "string", description: "Genre(s), e.g. 'Afrobeats, R&B'" },
    bioHtml: {
      type: "string",
      description:
        "Full bio as HTML using <p> and <h3> section headers only (e.g. <h3>Early Life & Education</h3>, <h3>Career Beginnings</h3>, <h3>Rise to Stardom</h3>, <h3>Recent Work</h3>, <h3>Legacy & Influence</h3>), following the exact structure and tone of a Wikipedia-style artist profile. Sections should flow naturally based on what's actually known - skip a section entirely if there's nothing substantive and confident to say.",
    },
    discography: {
      type: "array",
      description:
        "Real albums/EPs in chronological order, each with a real, accurate track list (only tracks you are confident are real). Empty array if no confidently-known discography exists.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          year: { type: "string" },
          tracks: { type: "array", items: { type: "string" } },
        },
        required: ["title", "year", "tracks"],
        additionalProperties: false,
      },
    },
  },
  required: ["realName", "aliasName", "dateOfBirth", "hometown", "label", "genre", "bioHtml", "discography"],
  additionalProperties: false,
} as const;

export const ARTIST_BIO_SYSTEM_PROMPT = `You are a music journalist writing artist profile pages for an African music blog (Afrobeats, Amapiano, Bongo Flava, Gospel, and related genres), in the style of a well-researched Wikipedia/AllMusic artist page.

You will be given an artist's name. Write a complete, accurate profile based on your own knowledge of this real artist.

Accuracy rules:
- State specific facts (real name, date of birth, hometown, label, album/track names) ONLY when you are genuinely confident they are real and correct, the same way a careful music journalist would.
- If you are not confident about a specific fact (e.g. exact date of birth), leave that field as an empty string rather than guessing or inventing a plausible-sounding value. Never state a specific fact you are unsure about.
- The discography must be REAL albums/EPs and REAL tracks from this artist's actual catalogue. Do not invent album titles or tracklists. If you don't confidently know their discography, return an empty array.
- Do not invent chart positions, certifications, or awards you're not confident are real.

Tone: polished, editorial, informative - like a well-researched artist biography. Use clear section headers to organize the bio.`;

export function artistBioUserPrompt(artistName: string): string {
  return `Write a complete profile for the real music artist "${artistName}", covering their real name/alias/background if well-known, their genre, a structured bio (early life, career beginnings, rise to prominence, recent work, legacy), and their real album/EP discography with accurate track lists.`;
}
