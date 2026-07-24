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

  /** Resolves names against a WP taxonomy endpoint (e.g. /tags or /categories), creating missing terms. */
  private async resolveTerms(taxonomyPath: string, names: string[], credentials?: WpCredentials): Promise<number[]> {
    const ids: number[] = [];
    for (const name of names) {
      try {
        const found = await this.request<{ id: number; name: string }[]>(
          `${taxonomyPath}?search=${encodeURIComponent(name)}`,
          {},
          credentials,
        );
        const match = found.find((t) => t.name.toLowerCase() === name.toLowerCase());
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
   */
  resolveTags(rawNames: string[], credentials?: WpCredentials): Promise<number[]> {
    return this.resolveTerms("/tags", this.splitArtistTags(rawNames), credentials);
  }

  /** Resolves tag IDs to their names, for diffing "which collaborators are already tagged". */
  async getTagNames(tagIds: number[], credentials?: WpCredentials): Promise<string[]> {
    if (tagIds.length === 0) return [];
    const found = await this.request<{ id: number; name: string }[]>(
      `/tags?include=${tagIds.join(",")}&per_page=${tagIds.length}`,
      {},
      credentials,
    );
    return found.map((t) => t.name);
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

  /** Downloads an image and uploads it to the WP media library. Returns the media ID, or undefined on failure. */
  private async uploadFeaturedImage(
    imageUrl: string,
    filenameHint: string,
    credentials?: WpCredentials,
  ): Promise<number | undefined> {
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
      const media = (await res.json()) as { id: number };
      return media.id;
    } catch (err) {
      this.logger.warn(`Skipping featured image: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Fetches all posts by an artist (via tag or search), for auditing purposes. */
  async findPostsByArtist(
    artist: string,
    perPage = 20,
    credentials?: WpCredentials,
  ): Promise<{ id: number; link: string; title: string }[]> {
    const found = await this.request<{ id: number; link: string; title: { rendered: string } }[]>(
      `/posts?search=${encodeURIComponent(artist)}&per_page=${perPage}&_fields=id,link,title`,
      {},
      credentials,
    );
    return found.map((p) => ({ id: p.id, link: p.link, title: p.title.rendered }));
  }

  /** Fetches one post's full content/excerpt/tags for auditing. */
  async getPostForAudit(
    id: number,
    credentials?: WpCredentials,
  ): Promise<{ id: number; link: string; title: string; contentHtml: string; excerpt: string; tags: number[] }> {
    const post = await this.request<{
      id: number;
      link: string;
      title: { rendered: string };
      content: { rendered: string };
      excerpt: { rendered: string };
      tags: number[];
    }>(`/posts/${id}?_fields=id,link,title,content,excerpt,tags`, {}, credentials);
    return {
      id: post.id,
      link: post.link,
      title: post.title.rendered,
      contentHtml: post.content.rendered,
      excerpt: post.excerpt.rendered,
      tags: post.tags,
    };
  }

  /** Applies an audit fix to an existing post: new content, excerpt, and/or tags. */
  async updatePost(
    id: number,
    changes: { content?: string; excerpt?: string; tags?: number[] },
    credentials?: WpCredentials,
  ): Promise<{ id: number; link: string }> {
    const post = await this.request<{ id: number; link: string }>(
      `/posts/${id}`,
      { method: "POST", body: JSON.stringify(changes) },
      credentials,
    );
    return post;
  }

  async publishArticle(
    article: GeneratedArticle,
    imageUrl?: string,
    categoryName?: string,
    credentials?: WpCredentials,
  ): Promise<PublishResult> {
    const tagIds = await this.resolveTags(article.tags, credentials);
    const categoryId = categoryName ? await this.resolveCategory(categoryName, credentials) : undefined;
    const featuredMediaId = imageUrl
      ? await this.uploadFeaturedImage(imageUrl, article.title, credentials)
      : undefined;

    const post = await this.request<{ id: number; link: string; status: string }>(
      "/posts",
      {
        method: "POST",
        body: JSON.stringify({
          title: article.title,
          excerpt: article.excerpt,
          content: article.bodyHtml,
          tags: tagIds,
          ...(categoryId ? { categories: [categoryId] } : {}),
          status: this.postStatus,
          ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
        }),
      },
      credentials,
    );
    return { id: post.id, link: post.link, status: post.status };
  }
}
