import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface StreamingLink {
  platform: "Spotify" | "Audiomack" | "YouTube";
  url: string;
}

/**
 * Finds a streaming link for a song: Spotify first (needs SPOTIFY_CLIENT_ID/SECRET),
 * then Audiomack (search page - their track API is partner-only), then YouTube.
 */
@Injectable()
export class LinksService {
  private readonly logger = new Logger(LinksService.name);
  private readonly spotifyClientId?: string;
  private readonly spotifyClientSecret?: string;
  private spotifyToken?: { value: string; expiresAt: number };

  constructor(config: ConfigService) {
    this.spotifyClientId = config.get<string>("SPOTIFY_CLIENT_ID");
    this.spotifyClientSecret = config.get<string>("SPOTIFY_CLIENT_SECRET");
  }

  async findStreamingLink(artist: string, songTitle: string): Promise<StreamingLink | null> {
    const query = `${artist} ${songTitle}`;

    const spotify = await this.trySpotify(query);
    if (spotify) return spotify;

    const youtube = await this.tryYouTube(query);
    if (youtube) return youtube;

    // Audiomack last: no public search API, so this is a search-page link
    return {
      platform: "Audiomack",
      url: `https://audiomack.com/search?q=${encodeURIComponent(query)}`,
    };
  }

  private async trySpotify(query: string): Promise<StreamingLink | null> {
    const track = await this.searchSpotifyTrack(query);
    return track ? { platform: "Spotify", url: track.url } : null;
  }

  private async searchSpotifyTrack(query: string): Promise<{ url: string; id: string } | null> {
    if (!this.spotifyClientId || !this.spotifyClientSecret) return null;
    try {
      const token = await this.getSpotifyToken();
      const url = new URL("https://api.spotify.com/v1/search");
      url.searchParams.set("q", query);
      url.searchParams.set("type", "track");
      url.searchParams.set("limit", "1");
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Spotify search failed (${res.status})`);
      const data = (await res.json()) as {
        tracks: { items: { id: string; external_urls: { spotify: string } }[] };
      };
      const track = data.tracks.items[0];
      return track ? { url: track.external_urls.spotify, id: track.id } : null;
    } catch (err) {
      this.logger.warn(`Spotify lookup failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Returns an embeddable open.spotify.com/embed/track/... URL for use in an <iframe>, or null if not found. */
  async findSpotifyEmbedUrl(artist: string, songTitle: string): Promise<string | null> {
    const track = await this.searchSpotifyTrack(`${artist} ${songTitle}`);
    return track ? `https://open.spotify.com/embed/track/${track.id}` : null;
  }

  private async getSpotifyToken(): Promise<string> {
    if (this.spotifyToken && Date.now() < this.spotifyToken.expiresAt) {
      return this.spotifyToken.value;
    }
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${this.spotifyClientId}:${this.spotifyClientSecret}`).toString("base64"),
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.spotifyToken = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    return data.access_token;
  }

  async findYouTubeLink(artist: string, songTitle: string): Promise<StreamingLink | null> {
    return this.tryYouTube(`${artist} ${songTitle}`);
  }

  private async tryYouTube(query: string): Promise<StreamingLink | null> {
    try {
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      });
      if (!res.ok) throw new Error(`YouTube search failed (${res.status})`);
      const html = await res.text();
      const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      return match ? { platform: "YouTube", url: `https://www.youtube.com/watch?v=${match[1]}` } : null;
    } catch (err) {
      this.logger.warn(`YouTube lookup failed: ${(err as Error).message}`);
      return null;
    }
  }
}
