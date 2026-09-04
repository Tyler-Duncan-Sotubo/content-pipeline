import { Injectable, Logger } from "@nestjs/common";

export interface SourcePost {
  id: number;
  link: string;
  title: string;
  date: string;
  excerpt: string;
  imageUrl?: string;
}

export interface SourceSiteConfig {
  /** Base URL of the source WordPress site, e.g. https://djmwanga.com */
  baseUrl: string;
  /** Only consider posts from the last N days (0 = no limit). */
  lookbackDays?: number;
  /**
   * Exclude posts from the last N days (e.g. during a backfill, so this run
   * doesn't compete with production's live crons for the same recent posts).
   */
  excludeLastDays?: number;
  /**
   * The MP3 download link's HTML pattern varies by site:
   * - "download-attr": <a href="....mp3" ... download> (djmwanga, ckmusicpromos)
   * - "any-mp3-link": any <a href="....mp3"> link, no attribute required (ceenaija)
   */
  downloadLinkStyle?: "download-attr" | "any-mp3-link";
}

interface WpPost {
  id: number;
  link: string;
  date: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  _embedded?: {
    "wp:featuredmedia"?: { source_url?: string }[];
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/\[&hellip;\]|&hellip;/g, "…")
    .trim();
}

const USER_AGENT = "Mozilla/5.0 (content-pipeline)";

@Injectable()
export class SourceService {
  private readonly logger = new Logger(SourceService.name);

  private async fetchPosts(site: SourceSiteConfig, params: Record<string, string>): Promise<SourcePost[]> {
    const baseUrl = site.baseUrl.replace(/\/$/, "");
    const url = new URL(`${baseUrl}/wp-json/wp/v2/posts`);
    // Don't combine `_fields` with `_embed` - some source sites' `_fields` filter
    // strips `_embedded` entirely (nested-path filtering isn't supported), so the
    // featured image silently disappears. Fetch full posts instead.
    url.searchParams.set("_embed", "wp:featuredmedia");
    const lookbackDays = site.lookbackDays ?? 0;
    if (lookbackDays > 0) {
      const after = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      url.searchParams.set("after", after.toISOString());
    }
    const excludeLastDays = site.excludeLastDays ?? 0;
    if (excludeLastDays > 0) {
      const before = new Date(Date.now() - excludeLastDays * 24 * 60 * 60 * 1000);
      url.searchParams.set("before", before.toISOString());
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Source fetch failed (${res.status}): ${url}`);
    const posts = (await res.json()) as WpPost[];
    return posts.map((p) => ({
      id: p.id,
      link: p.link,
      title: stripHtml(p.title.rendered),
      date: p.date,
      excerpt: stripHtml(p.excerpt.rendered),
      imageUrl: p._embedded?.["wp:featuredmedia"]?.[0]?.source_url,
    }));
  }

  /**
   * The MP3 download URL isn't in the WP REST API - it's scraped from the
   * rendered post page. Pattern varies by site; see SourceSiteConfig.downloadLinkStyle.
   */
  async findDownloadUrl(postLink: string, style: SourceSiteConfig["downloadLinkStyle"] = "download-attr"): Promise<string | undefined> {
    try {
      const res = await fetch(postLink, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`Post page fetch failed (${res.status})`);
      const html = await res.text();
      const pattern =
        style === "any-mp3-link"
          ? /<a[^>]+href="([^"]+\.mp3[^"]*)"/i
          : /<a[^>]+href="([^"]+\.mp3[^"]*)"[^>]*\sdownload\b/i;
      const match = html.match(pattern);
      return match ? match[1].replace(/&amp;/g, "&") : undefined;
    } catch (err) {
      this.logger.warn(`Could not find download URL for ${postLink}: ${(err as Error).message}`);
      return undefined;
    }
  }

  latestPosts(site: SourceSiteConfig, perPage = 20): Promise<SourcePost[]> {
    return this.fetchPosts(site, { per_page: String(perPage) });
  }

  /**
   * WordPress's ?search= does loose relevance matching across the whole page,
   * not "this artist is credited here" - e.g. searching "Lava Lava" can match
   * a post that only contains the unrelated substring "LavaTablet" in embedded
   * JS, or fuzzy-matches "flava"/"lava" in an unrelated excerpt. Only trust a
   * result if the artist name genuinely appears in the post TITLE, which is
   * where a real artist credit belongs ("Artist - Song" / "Artist Ft. X - Song").
   */
  private titleMatchesArtist(title: string, artist: string): boolean {
    // Spaces are stripped entirely, not collapsed: source sites disagree with
    // our artist list on where the space goes. djmwanga writes "Alikiba"
    // while artists.json has "Ali Kiba", so a space-preserving comparison
    // rejected every one of his releases as a false positive - confirmed
    // live, it silently dropped "Alikiba - Hater" (Sept 3) and months of
    // earlier posts. Removing spaces makes both sides collapse to "alikiba".
    //
    // This does not loosen the guard in practice: artist names are long and
    // distinctive enough that unrelated titles still fail. Verified against
    // real source titles that "Kibambe" and "Kibanda Cha Rasta" are still
    // correctly rejected for "Ali Kiba".
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "")
        .trim();
    return normalize(title).includes(normalize(artist));
  }

  async searchByArtist(site: SourceSiteConfig, artist: string, perPage = 10): Promise<SourcePost[]> {
    const posts = await this.fetchPosts(site, { search: artist, per_page: String(perPage) });
    const filtered = posts.filter((p) => this.titleMatchesArtist(p.title, artist));
    const dropped = posts.length - filtered.length;
    if (dropped > 0) {
      this.logger.warn(
        `Dropped ${dropped} false-positive search result(s) for "${artist}" (title didn't actually contain the artist name)`
      );
    }
    return filtered;
  }

  /**
   * Collect posts for artist "triggers". Empty list falls back to latest posts.
   * De-dupes across artists.
   */
  async collectPosts(site: SourceSiteConfig, artists: string[], perArtist = 5): Promise<SourcePost[]> {
    if (artists.length === 0) return this.latestPosts(site);

    const seen = new Set<number>();
    const results: SourcePost[] = [];
    for (const artist of artists) {
      this.logger.log(`Searching ${site.baseUrl} for "${artist}"`);
      const posts = await this.searchByArtist(site, artist, perArtist);
      for (const post of posts) {
        if (!seen.has(post.id)) {
          seen.add(post.id);
          results.push(post);
        }
      }
    }
    return results;
  }
}
