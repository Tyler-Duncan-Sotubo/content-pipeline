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

  searchByArtist(site: SourceSiteConfig, artist: string, perPage = 10): Promise<SourcePost[]> {
    return this.fetchPosts(site, { search: artist, per_page: String(perPage) });
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
