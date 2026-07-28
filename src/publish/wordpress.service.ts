import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GeneratedArticle } from "../generate/generator.service";

export interface PublishResult {
  id: number;
  link: string;
  status: string;
}

export interface WpCredentials {
  user: string;
  appPassword: string;
}

@Injectable()
export class WordpressService {
  private readonly logger = new Logger(WordpressService.name);
  private readonly baseUrl: string;
  private readonly defaultAuthHeader: string;
  private readonly postStatus: "draft" | "publish";

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>("WP_URL").replace(/\/$/, "");
    const user = config.getOrThrow<string>("WP_USER");
    const password = config.getOrThrow<string>("WP_APP_PASSWORD");
    this.defaultAuthHeader = this.buildAuthHeader({ user, appPassword: password });
    this.postStatus = (config.get<string>("WP_POST_STATUS") ?? "draft") as "draft" | "publish";
  }

  private buildAuthHeader(creds: WpCredentials): string {
    return "Basic " + Buffer.from(`${creds.user}:${creds.appPassword}`).toString("base64");
  }

  private async request<T>(path: string, init: RequestInit = {}, credentials?: WpCredentials): Promise<T> {
    const authHeader = credentials ? this.buildAuthHeader(credentials) : this.defaultAuthHeader;
    const res = await fetch(`${this.baseUrl}/wp-json/wp/v2${path}`, {
      ...init,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string>),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WordPress ${init.method ?? "GET"} ${path} failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Splits "Jux Ft. Mbosso" / "A feat B" / "A & B" / "A, B" into separate artist names. */
  private splitArtistTags(names: string[]): string[] {
    const split = names.flatMap((name) =>
      name.split(/\s*(?:ft\.?|feat\.?|featuring|&|,|\bx\b)\s*/i).filter(Boolean)
    );
    return [...new Set(split.map((n) => n.trim()).filter(Boolean))];
  }

  private normalizeTermName(s: string): string {
    return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
  }

  /**
   * Resolves names against a WP taxonomy endpoint (e.g. /tags or /categories),
   * creating missing terms. Matching is normalization-tolerant (case, accents,
   * punctuation) so an artist who already has an established tag/"artist page"
   * (e.g. "Sauti Sol") is always reused instead of a near-duplicate tag getting
   * created for a slightly different-looking variant of the same name.
   */
  private async resolveTerms(taxonomyPath: string, names: string[], credentials?: WpCredentials): Promise<number[]> {
    const ids: number[] = [];
    for (const name of names) {
      try {
        const found = await this.request<{ id: number; name: string }[]>(
          `${taxonomyPath}?search=${encodeURIComponent(name)}`,
          {},
          credentials,
        );
        const target = this.normalizeTermName(name);
        const match = found.find((t) => this.normalizeTermName(t.name) === target);
        if (match) {
          ids.push(match.id);
        } else {
          const created = await this.request<{ id: number }>(
            taxonomyPath,
            { method: "POST", body: JSON.stringify({ name }) },
            credentials,
          );
          ids.push(created.id);
        }
      } catch (err) {
        this.logger.warn(`Skipping term "${name}" (${taxonomyPath}): ${(err as Error).message}`);
      }
    }
    return ids;
  }

  /**
   * Resolve tag names to IDs, creating any that don't exist yet. Tag creation
   * requires Editor/Admin role; if the WP user can't create terms, skip those
   * tags rather than failing the whole post.
   *
   * The LLM's `tags` field is not reliable on its own - it sometimes drops a
   * featured artist or the primary artist entirely. `article.artist` (parsed
   * straight from the source post, e.g. "Jux Ft. Mbosso") is the ground truth
   * for who's on the track, so it's always unioned into the tag list here
   * rather than trusting the model's tags array alone.
   */
  resolveTags(rawNames: string[], articleArtist: string, credentials?: WpCredentials): Promise<number[]> {
    const names = this.splitArtistTags([...rawNames, articleArtist]);
    return this.resolveTerms("/tags", names, credentials);
  }

  /**
   * tooxclusive.com has a dedicated per-artist hub page at /artists/{slug}/
   * (a WP `page`, not a tag) for artists it has profiled, e.g.
   * https://tooxclusive.com/artists/ruger/. When one exists for this artist,
   * we link the Artist metadata line to it instead of the plain tag archive -
   * confirmed live via GET /wp-json/wp/v2/pages?search=<name>.
   */
  async findArtistPage(
    artistName: string,
    credentials?: WpCredentials,
  ): Promise<{ link: string } | undefined> {
    try {
      const found = await this.request<{ link: string; title: { rendered: string } }[]>(
        `/pages?search=${encodeURIComponent(artistName)}`,
        {},
        credentials,
      );
      const target = this.normalizeTermName(artistName);
      const match = found.find(
        (p) => this.normalizeTermName(p.title.rendered) === target && p.link.includes("/artists/"),
      );
      return match ? { link: match.link } : undefined;
    } catch (err) {
      this.logger.warn(`Artist page lookup failed for "${artistName}": ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Checks tooxclusive itself for an existing post matching this artist + song
   * title. This is independent of state.json - a second line of defense against
   * duplicates when local and production state files have drifted out of sync
   * (state.json is per-machine and gitignored, so it can't be trusted alone).
   * Matches only if the found post's title contains both the artist name and
   * song title (loosely normalized) to avoid false positives on generic words.
   */
  async findExistingPost(
    artist: string,
    songTitle: string,
    credentials?: WpCredentials,
  ): Promise<{ id: number; link: string } | undefined> {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const primaryArtist = artist.split(/\s*(?:ft\.?|feat\.?|featuring|&|,|\bx\b)\s*/i)[0].trim();
    const query = `${primaryArtist} ${songTitle}`;

    try {
      const found = await this.request<{ id: number; link: string; title: { rendered: string } }[]>(
        `/posts?search=${encodeURIComponent(query)}&per_page=5`,
        {},
        credentials,
      );

      const artistNorm = normalize(primaryArtist);
      const titleNorm = normalize(songTitle);
      const match = found.find((p) => {
        const postTitle = normalize(p.title.rendered);
        return postTitle.includes(artistNorm) && postTitle.includes(titleNorm);
      });

      return match ? { id: match.id, link: match.link } : undefined;
    } catch (err) {
      this.logger.warn(`Duplicate check failed for "${query}": ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Resolve the country's category (e.g. "Tanzania") to its ID. This is a fixed,
   * curated taxonomy on tooxclusive - matched only, never created, so a typo
   * or missing category doesn't spam new categories onto the site.
   */
  private async resolveCategory(name: string, credentials?: WpCredentials): Promise<number | undefined> {
    try {
      const found = await this.request<{ id: number; name: string }[]>(
        `/categories?search=${encodeURIComponent(name)}`,
        {},
        credentials,
      );
      const match = found.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!match) this.logger.warn(`Category "${name}" not found on WordPress - skipping`);
      return match?.id;
    } catch (err) {
      this.logger.warn(`Could not resolve category "${name}": ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Downloads an image from the source site and uploads it to our own WP media
   * library. Returns both the media ID (for featured_media) and the resulting
   * URL on OUR domain, so the body content can reference our own copy instead
   * of hotlinking the source site's image.
   */
  private async uploadFeaturedImage(
    imageUrl: string,
    filenameHint: string,
    credentials?: WpCredentials,
  ): Promise<{ id: number; url: string } | undefined> {
    try {
      const imgRes = await fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0 (content-pipeline)" } });
      if (!imgRes.ok) throw new Error(`Image fetch failed (${imgRes.status})`);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const contentType = imgRes.headers.get("content-type") ?? "image/jpeg";
      const ext = contentType.split("/")[1]?.split(";")[0] ?? "jpg";
      const filename = `${filenameHint.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.${ext}`;
      const authHeader = credentials ? this.buildAuthHeader(credentials) : this.defaultAuthHeader;

      const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/media`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
        body: buffer,
      });
      if (!res.ok) throw new Error(`Media upload failed (${res.status}): ${await res.text()}`);
      const media = (await res.json()) as { id: number; source_url: string };
      return { id: media.id, url: media.source_url };
    } catch (err) {
      this.logger.warn(`Skipping featured image: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Fetches raw posts in a category, paginated. Used by the retag/relink backfill script. */
  async listPostsByCategory(
    categoryId: number,
    page: number,
    perPage = 50,
    credentials?: WpCredentials,
  ): Promise<{ id: number; link: string; title: { rendered: string }; content: { rendered: string }; tags: number[] }[]> {
    return this.request(
      `/posts?categories=${categoryId}&page=${page}&per_page=${perPage}&_fields=id,link,title,content,tags`,
      {},
      credentials,
    );
  }

  /** Resolves a category name to its ID (public wrapper for the backfill script). */
  resolveCategoryId(name: string, credentials?: WpCredentials): Promise<number | undefined> {
    return this.resolveCategory(name, credentials);
  }

  /** Resolves a category by its exact slug (not name) - used by the freshness cron. */
  async resolveCategoryIdBySlug(slug: string): Promise<number | undefined> {
    const found = await this.request<{ id: number; slug: string }[]>(
      `/categories?slug=${encodeURIComponent(slug)}`,
    );
    return found.find((c) => c.slug === slug)?.id;
  }

  /** Resolve tag names to IDs without unioning in any extra artist name. Used by the backfill script. */
  resolveTagsOnly(names: string[], credentials?: WpCredentials): Promise<number[]> {
    return this.resolveTerms("/tags", this.splitArtistTags(names), credentials);
  }

  /**
   * Patches a post's tags and/or content. Used by the additive-only retag/relink
   * backfill script - callers are responsible for merging with existing data
   * (e.g. union tags, don't overwrite) before calling this.
   */
  async patchPost(
    postId: number,
    updates: { tags?: number[]; content?: string },
    credentials?: WpCredentials,
  ): Promise<void> {
    await this.request(
      `/posts/${postId}`,
      { method: "POST", body: JSON.stringify(updates) },
      credentials,
    );
  }

  /** Creates a WP page. Used by the artist-page builder script. */
  async createPage(params: {
    title: string;
    slug: string;
    content: string;
    parent?: number;
    meta?: Record<string, unknown>;
  }): Promise<{ id: number; link: string }> {
    return this.request(`/pages`, {
      method: "POST",
      body: JSON.stringify({ ...params, status: "publish" }),
    });
  }

  /** Looks up a page by its exact slug. Used by the artist-page builder script to update in place. */
  async findPageBySlug(slug: string): Promise<{ id: number; link: string } | undefined> {
    const found = await this.request<{ id: number; link: string; slug: string }[]>(
      `/pages?slug=${encodeURIComponent(slug)}`,
    );
    return found.find((p) => p.slug === slug);
  }

  /** Updates an existing WP page's content/meta in place. Used by the artist-page builder script. */
  async updatePage(
    pageId: number,
    params: { content: string; meta?: Record<string, unknown> },
  ): Promise<{ id: number; link: string }> {
    return this.request(`/pages/${pageId}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * Fetches posts in a category, newest-ID-first, with date/modified fields
   * included. Used by the freshness-refresh cron to find posts due for their
   * periodic "Last updated" line refresh.
   *
   * Deliberately ordered/filtered by ID, not by the `date` field - a mass
   * post_date-rewrite incident (confirmed live: thousands of old posts across
   * Jan-Mar 2026 have fake recent `date` values, interleaved second-by-second
   * with genuinely new posts) makes `date` unreliable as a recency filter.
   * Post ID is monotonically real - it can't be faked without actually
   * creating a new post - so callers should filter on `id >= minId` instead.
   */
  async listPostsByCategoryNewestFirst(
    categoryId: number,
    page: number,
    perPage = 100,
  ): Promise<{ id: number; link: string; date: string; modified: string; content: { rendered: string } }[]> {
    return this.request(
      `/posts?categories=${categoryId}&page=${page}&per_page=${perPage}` +
        `&orderby=id&order=desc&_fields=id,link,date,modified,content`,
    );
  }

  /** Fetches a single post's content and author ID. Used by the freshness-refresh cron. */
  async getPostContent(
    postId: number,
  ): Promise<{ id: number; link: string; content: string; author: number }> {
    const post = await this.request<{
      id: number;
      link: string;
      content: { rendered: string };
      author: number;
    }>(`/posts/${postId}?_fields=id,link,content,author`);
    return { id: post.id, link: post.link, content: post.content.rendered, author: post.author };
  }

  /** Resolves a WP user ID to their display name + author archive URL. Used by the freshness-refresh cron for the byline. */
  async getUserInfo(userId: number): Promise<{ name: string; link: string }> {
    const user = await this.request<{ name: string; link: string }>(`/users/${userId}`);
    return { name: user.name, link: user.link };
  }

  async publishArticle(
    article: GeneratedArticle,
    imageUrl?: string,
    categoryName?: string,
    credentials?: WpCredentials,
  ): Promise<PublishResult> {
    const tagIds = await this.resolveTags(article.tags, article.artist, credentials);
    if (tagIds.length === 0) {
      throw new Error(
        `Refusing to publish "${article.title}" untagged - tag resolution returned zero tags for artist(s) "${article.artist}"`,
      );
    }
    const categoryId = categoryName ? await this.resolveCategory(categoryName, credentials) : undefined;
    const uploadedImage = imageUrl
      ? await this.uploadFeaturedImage(imageUrl, article.title, credentials)
      : undefined;

    // Use our own uploaded copy of the image in the body, not the source
    // site's URL - avoids hotlinking and a second, duplicate <img> tag.
    const bodyWithOurImage = uploadedImage
      ? article.bodyHtml.replace(imageUrl!, uploadedImage.url)
      : article.bodyHtml;

    const post = await this.request<{ id: number; link: string; status: string }>(
      "/posts",
      {
        method: "POST",
        body: JSON.stringify({
          title: article.title,
          excerpt: article.excerpt,
          content: bodyWithOurImage,
          tags: tagIds,
          ...(categoryId ? { categories: [categoryId] } : {}),
          status: this.postStatus,
          ...(uploadedImage ? { featured_media: uploadedImage.id } : {}),
        }),
      },
      credentials,
    );
    return { id: post.id, link: post.link, status: post.status };
  }
}
