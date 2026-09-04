import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GeneratorService } from "../generate/generator.service";
import { WordpressService, WpCredentials } from "../publish/wordpress.service";

/**
 * Entertainment/news aggregation - deliberately separate from the music
 * pipeline in every respect that matters:
 *
 *  - its own artist list (artists-entertainment.json). The music lists cover
 *    Tanzania/Ghana/Gospel/Kenya; Nigerian mainstream names like Davido and
 *    Wizkid appear in none of them, because the music sources are regional
 *    sites. Confirmed live: the Davido/Erigga story matched zero entries in
 *    the music lists.
 *  - its own state file, so a story here can never collide with a song there.
 *  - its own WordPress author (WP_USER_ENTERTAINMENT), so these posts don't
 *    publish under a music editor's byline.
 *
 * Scope guard: a story is only ingested if its TITLE names an artist on the
 * entertainment list. That filter is the entire safety mechanism, because
 * these posts auto-publish with no human review and the source covers a lot
 * of material about private individuals that has no place here. Measured
 * against real source headlines it admitted 4 of 11 - the four genuine
 * music-artist stories - and rejected politics, reality TV and
 * private-individual items.
 */
const SOURCE_URL = "https://www.gistreel.com";

interface EntertainmentState {
  /** source post id -> ISO timestamp we published it */
  processed: Record<string, string>;
}

export interface SourceEntertainmentPost {
  id: number;
  title: string;
  bodyHtml: string;
  link: string;
  date: string;
  featuredMediaId: number;
}

@Injectable()
export class EntertainmentService {
  private readonly logger = new Logger(EntertainmentService.name);
  private readonly stateFile = join(process.cwd(), "entertainment-state.json");
  private readonly artistsFile = join(process.cwd(), "artists-entertainment.json");
  private readonly categorySlug: string;
  private readonly credentials?: WpCredentials;

  constructor(
    private readonly wordpress: WordpressService,
    private readonly generator: GeneratorService,
    config: ConfigService,
  ) {
    this.categorySlug = config.get<string>("ENTERTAINMENT_CATEGORY_SLUG") ?? "entertainment";
    const user = config.get<string>("WP_USER_ENTERTAINMENT");
    const appPassword = config.get<string>("WP_APP_PASSWORD_ENTERTAINMENT");
    // Falls back to the default account only if a dedicated one isn't set,
    // matching how the gospel/ghana/kenya pipelines behave.
    this.credentials = user && appPassword ? { user, appPassword } : undefined;
  }

  private loadState(): EntertainmentState {
    if (!existsSync(this.stateFile)) return { processed: {} };
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as EntertainmentState;
    } catch {
      return { processed: {} };
    }
  }

  private markProcessed(sourceId: number): void {
    // Re-read at write time so a concurrent run can't erase our entry.
    const current = this.loadState();
    current.processed[String(sourceId)] = new Date().toISOString();
    writeFileSync(this.stateFile, JSON.stringify(current, null, 2));
  }

  private loadArtists(): string[] {
    if (!existsSync(this.artistsFile)) {
      this.logger.warn(`${this.artistsFile} not found - nothing to match against`);
      return [];
    }
    return JSON.parse(readFileSync(this.artistsFile, "utf8")) as string[];
  }

  /**
   * Requires a non-alphanumeric boundary either side of the name, while
   * allowing the separator *inside* it to differ ("Ali Kiba" vs "Alikiba").
   * A plain substring test is too loose here: checked against a general
   * entertainment feed, "Nolly" matched "Nollywood" four times.
   */
  private titleNamesArtist(title: string, artist: string): boolean {
    const pattern = artist.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "[^a-z0-9]*");
    if (!pattern) return false;
    return new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`, "i").test(
      title.toLowerCase().normalize("NFKD"),
    );
  }

  private decodeEntities(s: string): string {
    return s
      .replace(/&#8217;|&#39;|&rsquo;/g, "'")
      .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
      .replace(/&#8211;|&ndash;/g, "–")
      .replace(/&#8212;|&mdash;/g, "—")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)));
  }

  private stripHtml(s: string): string {
    return this.decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  }

  /**
   * One request per run for the recent feed, then all matching happens in
   * memory. Deliberately not a search-per-artist: with 45 artists that would
   * be 45 requests per run against a third-party site, and heavy scanning
   * already provoked sustained 504s from this source during development.
   */
  async fetchRecent(perPage = 40): Promise<SourceEntertainmentPost[]> {
    const url =
      `${SOURCE_URL}/wp-json/wp/v2/posts?per_page=${perPage}` +
      `&orderby=date&order=desc&_fields=id,title,content,link,date,featured_media`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (content-pipeline)" } });
    if (!res.ok) throw new Error(`Source fetch failed (${res.status})`);
    const raw = (await res.json()) as {
      id: number;
      title: { rendered: string };
      content: { rendered: string };
      link: string;
      date: string;
      featured_media: number;
    }[];
    return raw.map((p) => ({
      id: p.id,
      title: this.decodeEntities(p.title.rendered),
      bodyHtml: p.content.rendered,
      link: p.link,
      date: p.date,
      featuredMediaId: p.featured_media,
    }));
  }

  /**
   * Keeps the in-body media the source used. GistReel screenshots social
   * posts rather than embedding them - across a 12-article sample every post
   * had either one <img> or one <blockquote> (an X embed), never an iframe -
   * so those are the two cases worth carrying over.
   */
  private extractMedia(bodyHtml: string): { images: string[]; blockquotes: string[] } {
    const images = [...bodyHtml.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const blockquotes = [...bodyHtml.matchAll(/<blockquote[\s\S]*?<\/blockquote>/g)].map((m) => m[0]);
    return { images, blockquotes };
  }

  /** Two "Read More" links pointing at our own recent posts for this artist. */
  private async readMoreLinks(artist: string, excludeTitle: string): Promise<string[]> {
    const tagId = await this.wordpress.findTagId(artist);
    if (!tagId) return [];
    const posts = await this.wordpress.recentPostsByTag(tagId, 6);
    return posts
      .filter((p) => this.stripHtml(p.title.rendered) !== excludeTitle)
      .slice(0, 2)
      .map(
        (p) =>
          `<p><strong>Read More:</strong> <a href="${p.link}">${this.stripHtml(p.title.rendered)}</a></p>`,
      );
  }

  private buildBody(params: {
    intro: string[];
    subheading: string;
    body: string[];
    closing: string;
    readMore: string[];
    imageHtml?: string;
    blockquotes: string[];
  }): string {
    const parts: string[] = [];
    parts.push(...params.intro.map((p) => `<p>${p}</p>`));
    if (params.readMore[0]) parts.push(params.readMore[0]);
    parts.push(`<h2>${params.subheading}</h2>`);
    if (params.imageHtml) parts.push(params.imageHtml);
    parts.push(...params.body.map((p) => `<p>${p}</p>`));
    parts.push(...params.blockquotes);
    parts.push(`<p>${params.closing}</p>`);
    if (params.readMore[1]) parts.push(params.readMore[1]);
    return parts.join("\n");
  }

  async runOnce(limit = 3, dryRun = false): Promise<{
    scanned: number;
    matched: number;
    published: number;
    skipped: number;
    failed: number;
  }> {
    const artists = this.loadArtists();
    const state = this.loadState();
    let scanned = 0;
    let matched = 0;
    let published = 0;
    let skipped = 0;
    let failed = 0;

    const posts = await this.fetchRecent();

    for (const post of posts) {
      if (published >= limit) break;
      scanned++;

      const hits = artists.filter((a) => this.titleNamesArtist(post.title, a));
      if (hits.length === 0) continue;
      matched++;

      if (state.processed[String(post.id)]) {
        skipped++;
        continue;
      }

      try {
        const generated = await this.generator.generateEntertainmentPost({
          sourceTitle: post.title,
          sourceBody: this.stripHtml(post.bodyHtml).slice(0, 6000),
          matchedArtists: hits,
        });

        // Title must not simply echo the source headline - that's both an SEO
        // problem and a sign the model ignored the rewrite instruction.
        if (this.stripHtml(generated.title).toLowerCase() === post.title.toLowerCase()) {
          this.logger.warn(`Skipping ${post.id}: generated title matches the source headline verbatim`);
          skipped++;
          continue;
        }

        // Prefer an image we already own for the primary artist; fall back to
        // the source's own image (re-uploaded, never hot-linked).
        let featuredMediaId: number | undefined;
        let ownedImageUrl: string | undefined;
        const primaryTagId = await this.wordpress.findTagId(hits[0]);
        if (primaryTagId) {
          const owned = await this.wordpress.findOwnedArtistImage(hits[0], primaryTagId);
          if (owned) {
            featuredMediaId = owned.id;
            ownedImageUrl = owned.url;
          }
        }

        const media = this.extractMedia(post.bodyHtml);
        if (!featuredMediaId && media.images[0]) {
          const uploaded = await this.wordpress.uploadFeaturedImage(
            media.images[0],
            generated.title,
            this.credentials,
          );
          if (uploaded) featuredMediaId = uploaded.id;
        }

        const readMore = await this.readMoreLinks(hits[0], generated.title);
        const imageHtml = ownedImageUrl
          ? `<p><img src="${ownedImageUrl}" alt="${generated.artists.join(", ")}" /></p>`
          : undefined;

        const content = this.buildBody({
          intro: generated.introParagraphs,
          subheading: generated.subheading,
          body: generated.bodyParagraphs,
          closing: generated.closingParagraph,
          readMore,
          imageHtml,
          blockquotes: media.blockquotes,
        });

        if (dryRun) {
          published++;
          this.logger.log(`[dry-run] Would publish: "${generated.title}" (artists: ${hits.join(", ")})`);
          continue;
        }

        const categoryId = await this.wordpress.resolveCategoryIdBySlug(this.categorySlug);
        const tagIds = await this.wordpress.resolveTagsExact(generated.tags.length ? generated.tags : hits, this.credentials);

        const result = await this.wordpress.createPost(
          {
            title: generated.title,
            excerpt: generated.excerpt,
            content,
            tagIds,
            categoryIds: categoryId ? [categoryId] : undefined,
            featuredMediaId,
          },
          this.credentials,
        );

        this.markProcessed(post.id);
        published++;
        this.logger.log(`Published "${generated.title}" -> ${result.link}`);
      } catch (err) {
        failed++;
        this.logger.warn(`Failed on source post ${post.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `Entertainment run done: scanned ${scanned}, matched ${matched}, published ${published}, skipped ${skipped}, failed ${failed}`,
    );
    return { scanned, matched, published, skipped, failed };
  }
}
