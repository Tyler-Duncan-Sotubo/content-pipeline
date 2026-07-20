export interface CountryConfig {
  code: string;
  name: string;
  /** Source WordPress site to pull song posts from. */
  sourceUrl: string;
  /** Name of the matching category on the destination WP site (tooxclusive.com), e.g. "Tanzania". */
  wpCategory: string;
  /** MP3 download-link HTML pattern for this source site. See SourceSiteConfig. */
  downloadLinkStyle?: "download-attr" | "any-mp3-link";
}

/**
 * One entry per country the pipeline covers. Tanzania is live; add new
 * entries here as more source sites come online (e.g. Zambia).
 */
export const COUNTRIES: Record<string, CountryConfig> = {
  TZ: {
    code: "TZ",
    name: "Tanzania",
    sourceUrl: "https://djmwanga.com",
    wpCategory: "Tanzania",
  },
};

export function getCountryConfig(code: string): CountryConfig {
  const country = COUNTRIES[code.toUpperCase()];
  if (!country) {
    throw new Error(
      `Unknown COUNTRY "${code}". Known countries: ${Object.keys(COUNTRIES).join(", ")}`
    );
  }
  return country;
}

export interface GospelSourceConfig {
  name: string;
  sourceUrl: string;
  wpCategory: string;
  downloadLinkStyle: "download-attr" | "any-mp3-link";
}

/** Gospel content source(s), independent of the country model - not scoped to one country. */
export const GOSPEL_SOURCE: GospelSourceConfig = {
  name: "CeeNaija Gospel",
  sourceUrl: "https://www.ceenaija.com",
  wpCategory: "Gospel",
  downloadLinkStyle: "any-mp3-link",
};
