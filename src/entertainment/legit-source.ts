import { Logger } from "@nestjs/common";

/**
 * Legit.ng as a second entertainment source.
 *
 * Unlike GistReel this is not WordPress - there's no REST API (/wp-json/
 * 404s) - so it's read via its entertainment RSS feed. The feed only carries
 * ~154-character summaries, which is far too thin to rewrite from, so the
 * article page is fetched for stories that actually match a tracked artist.
 * Filtering first keeps that to one page fetch per match rather than per item.
 *
 * Worth having: on a same-day comparison this feed carried 8 artist matches
 * against GistReel's 3.
 */
const FEED_URL = "https://www.legit.ng/rss/entertainment.rss";

/** Boilerplate and furniture that appears inside the article body. */
const NOISE_PATTERNS = [
  /^PAY ATTENTION/i,
  /^Source:/i,
  /Photo credit/i,
  /^Read also/i,
  /^See also/i,
  /legit\.ng/i,
  /^Follow us/i,
  /^Subscribe/i,
  /preferred source/i,
];

export interface LegitPost {
  id: string;
  title: string;
  link: string;
  date: string;
  summary: string;
  imageUrl?: string;
}

export class LegitSource {
  private readonly logger = new Logger(LegitSource.name);

  private decode(s: string): string {
    return s
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/&#8217;|&#39;|&rsquo;/g, "'")
      .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
      .replace(/&#8211;|&ndash;/g, "–")
      .replace(/&#8212;|&mdash;/g, "—")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  private field(item: string, tag: string): string {
    const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? this.decode(m[1]) : "";
  }

  /** One request: the entertainment feed. Filtering happens upstream. */
  async fetchFeed(): Promise<LegitPost[]> {
    const res = await fetch(FEED_URL, { headers: { "User-Agent": "Mozilla/5.0 (content-pipeline)" } });
    if (!res.ok) throw new Error(`Legit feed fetch failed (${res.status})`);
    const xml = await res.text();

    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const item = m[1];
      const link = this.field(item, "link");
      const enclosure = item.match(/<enclosure[^>]*url="([^"]+)"/);
      return {
        // The feed has no numeric id; the slug is stable and unique.
        id: link.replace(/\/$/, "").split("/").pop() ?? link,
        title: this.field(item, "title"),
        link,
        date: this.field(item, "pubDate"),
        summary: this.field(item, "description"),
        imageUrl: enclosure?.[1],
      };
    });
  }

  /**
   * Fetches and cleans the full article body.
   *
   * Two kinds of contamination have to be removed, both confirmed against a
   * real article:
   *  - "Read also" widgets, which inject headlines for entirely different
   *    stories mid-body ("Toyin Abraham loses composure...", "Erigga claps
   *    back at Davido..."). These are stripped structurally by their
   *    c-article-read-also__ classes rather than by wording, since the text
   *    itself looks like ordinary prose.
   *  - promo and credit lines ("PAY ATTENTION: Mark Legit.ng as a preferred
   *    source", "Photo credit...", "Source: Instagram").
   *
   * Without both, that furniture ends up in the generated article.
   */
  async fetchArticleBody(link: string): Promise<string> {
    const res = await fetch(link, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    });
    if (!res.ok) throw new Error(`Legit article fetch failed (${res.status})`);
    const html = await res.text();

    const container = html.match(/<article class="post__main js-article-body">([\s\S]*?)<\/article>/);
    if (!container) {
      this.logger.warn(`Could not locate article body for ${link}`);
      return "";
    }

    let body = container[1];
    body = body.replace(/<a[^>]*c-article-read-also__[\s\S]*?<\/a>/g, "");
    body = body.replace(/<[^>]*c-article-read-also__[\s\S]{0,600}?<\/div>/g, "");

    const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => this.decode(m[1]))
      .filter((t) => t.split(/\s+/).length > 4)
      .filter((t) => !NOISE_PATTERNS.some((p) => p.test(t)));

    return paragraphs.join("\n\n");
  }
}
