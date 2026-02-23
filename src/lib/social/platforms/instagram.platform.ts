import type {
  ISocialPlatform,
  OAuthUrl,
  TokenPair,
  PlatformAccount,
  PlatformContent,
  PublishResult,
  PostMetrics,
  AccountMetrics,
} from "./base.platform";
import { PlatformError } from "@/lib/utils/errors";
import crypto from "crypto";

const META_API_BASE = "https://graph.facebook.com/v21.0";

export class InstagramPlatform implements ISocialPlatform {
  platform = "instagram" as const;

  private get appId() {
    const id = process.env.META_APP_ID;
    if (!id) throw new PlatformError("instagram", "META_APP_ID no configurado");
    return id;
  }

  private get appSecret() {
    const secret = process.env.META_APP_SECRET;
    if (!secret)
      throw new PlatformError("instagram", "META_APP_SECRET no configurado");
    return secret;
  }

  async getAuthUrl(userId: string, redirectUri: string): Promise<OAuthUrl> {
    const state = crypto.randomBytes(16).toString("hex") + ":" + userId;
    // Development mode: basic scopes. Advanced (instagram_content_publish,
    // instagram_manage_insights) require App Review.
    const scopes = [
      "public_profile",
      "pages_show_list",
      "pages_read_engagement",
    ].join(",");

    const url =
      `https://www.facebook.com/v21.0/dialog/oauth?` +
      `client_id=${this.appId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}` +
      `&scope=${scopes}` +
      `&response_type=code`;

    return { url, state };
  }

  async handleCallback(code: string, redirectUri: string): Promise<TokenPair> {
    // Same OAuth flow as Facebook (Meta Graph API)
    const url =
      `${META_API_BASE}/oauth/access_token?` +
      `client_id=${this.appId}` +
      `&client_secret=${this.appSecret}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code=${code}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      throw new PlatformError("instagram", data.error.message);
    }

    // Exchange for long-lived token
    const longRes = await fetch(
      `${META_API_BASE}/oauth/access_token?` +
        `grant_type=fb_exchange_token` +
        `&client_id=${this.appId}` +
        `&client_secret=${this.appSecret}` +
        `&fb_exchange_token=${data.access_token}`
    );
    const longData = await longRes.json();

    return {
      accessToken: longData.access_token ?? data.access_token,
      expiresAt: new Date(
        Date.now() + (longData.expires_in ?? 5184000) * 1000
      ),
      scopes: [
        "instagram_basic",
        "instagram_content_publish",
        "instagram_manage_insights",
      ],
    };
  }

  async refreshToken(refreshTokenStr: string): Promise<TokenPair> {
    const url =
      `${META_API_BASE}/oauth/access_token?` +
      `grant_type=fb_exchange_token` +
      `&client_id=${this.appId}` +
      `&client_secret=${this.appSecret}` +
      `&fb_exchange_token=${refreshTokenStr}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      throw new PlatformError("instagram", data.error.message);
    }

    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 5184000) * 1000),
      scopes: ["instagram_basic", "instagram_content_publish"],
    };
  }

  async getAccount(accessToken: string): Promise<PlatformAccount> {
    // Get IG Business Account via Facebook Page
    const pagesRes = await fetch(
      `${META_API_BASE}/me/accounts?fields=id,name,instagram_business_account{id,username,profile_picture_url}&access_token=${accessToken}`
    );
    const pagesData = await pagesRes.json();

    if (pagesData.error) {
      throw new PlatformError("instagram", pagesData.error.message);
    }

    for (const page of pagesData.data ?? []) {
      if (page.instagram_business_account) {
        const ig = page.instagram_business_account;
        return {
          platformAccountId: ig.id,
          accountName: ig.username ?? page.name,
          accountType: "business",
          avatarUrl: ig.profile_picture_url,
        };
      }
    }

    throw new PlatformError(
      "instagram",
      "No se encontró una cuenta de Instagram Business conectada a tus páginas de Facebook."
    );
  }

  async publishContent(
    accessToken: string,
    content: PlatformContent
  ): Promise<PublishResult> {
    // Get IG account ID
    const account = await this.getAccount(accessToken);
    const igId = account.platformAccountId;

    const caption = `${content.caption}\n\n${content.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;

    // Step 1: Create media container
    const containerParams: Record<string, string> = {
      caption,
      access_token: accessToken,
    };

    if (content.mediaUrl && content.mediaType === "video") {
      containerParams.media_type = "REELS";
      containerParams.video_url = content.mediaUrl;
    } else if (content.mediaUrl) {
      containerParams.image_url = content.mediaUrl;
    } else {
      throw new PlatformError(
        "instagram",
        "Instagram requiere un media (imagen o video) para publicar."
      );
    }

    const containerRes = await fetch(`${META_API_BASE}/${igId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(containerParams),
    });
    const containerData = await containerRes.json();

    if (containerData.error) {
      throw new PlatformError("instagram", containerData.error.message);
    }

    const containerId = containerData.id;

    // Step 2: Publish the container
    const publishRes = await fetch(`${META_API_BASE}/${igId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: accessToken,
      }),
    });
    const publishData = await publishRes.json();

    if (publishData.error) {
      throw new PlatformError("instagram", publishData.error.message);
    }

    return {
      platformPostId: publishData.id,
      platformPostUrl: `https://www.instagram.com/p/${publishData.id}`,
    };
  }

  async getPostMetrics(
    accessToken: string,
    postId: string
  ): Promise<PostMetrics> {
    const res = await fetch(
      `${META_API_BASE}/${postId}/insights?metric=impressions,reach,likes,comments,shares,saved&access_token=${accessToken}`
    );
    const data = await res.json();

    const metrics: Record<string, number> = {};
    for (const item of data.data ?? []) {
      metrics[item.name] = item.values?.[0]?.value ?? 0;
    }

    return {
      views: metrics.impressions ?? 0,
      likes: metrics.likes ?? 0,
      comments: metrics.comments ?? 0,
      shares: metrics.shares ?? 0,
      saves: metrics.saved ?? 0,
      watchTimeSeconds: 0,
      avgWatchPercent: 0,
      reachUnique: metrics.reach ?? 0,
      impressions: metrics.impressions ?? 0,
      engagementRate: 0,
    };
  }

  async getAccountMetrics(
    accessToken: string,
    accountId: string
  ): Promise<AccountMetrics> {
    const res = await fetch(
      `${META_API_BASE}/${accountId}?fields=followers_count,media_count&access_token=${accessToken}`
    );
    const data = await res.json();

    return {
      followers: data.followers_count ?? 0,
      followersGrowth: 0,
      totalViews: 0,
      totalWatchMinutes: 0,
      avgEngagementRate: 0,
    };
  }
}
