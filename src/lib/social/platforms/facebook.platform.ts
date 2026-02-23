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

export class FacebookPlatform implements ISocialPlatform {
  platform = "facebook" as const;

  private get appId() {
    const id = process.env.META_APP_ID;
    if (!id) throw new PlatformError("facebook", "META_APP_ID no configurado");
    return id;
  }

  private get appSecret() {
    const secret = process.env.META_APP_SECRET;
    if (!secret)
      throw new PlatformError("facebook", "META_APP_SECRET no configurado");
    return secret;
  }

  async getAuthUrl(userId: string, redirectUri: string): Promise<OAuthUrl> {
    const state = crypto.randomBytes(16).toString("hex") + ":" + userId;
    const scopes = [
      "public_profile",
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
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
    const url =
      `${META_API_BASE}/oauth/access_token?` +
      `client_id=${this.appId}` +
      `&client_secret=${this.appSecret}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code=${code}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      throw new PlatformError("facebook", data.error.message, data.error);
    }

    // Exchange for long-lived token
    const longLivedUrl =
      `${META_API_BASE}/oauth/access_token?` +
      `grant_type=fb_exchange_token` +
      `&client_id=${this.appId}` +
      `&client_secret=${this.appSecret}` +
      `&fb_exchange_token=${data.access_token}`;

    const longRes = await fetch(longLivedUrl);
    const longData = await longRes.json();

    if (longData.error) {
      throw new PlatformError("facebook", longData.error.message);
    }

    return {
      accessToken: longData.access_token,
      expiresAt: new Date(Date.now() + (longData.expires_in ?? 5184000) * 1000),
      scopes: ["pages_manage_posts", "pages_read_engagement", "read_insights"],
    };
  }

  async refreshToken(refreshToken: string): Promise<TokenPair> {
    // Facebook long-lived tokens don't use traditional refresh
    // Re-exchange the existing token
    const url =
      `${META_API_BASE}/oauth/access_token?` +
      `grant_type=fb_exchange_token` +
      `&client_id=${this.appId}` +
      `&client_secret=${this.appSecret}` +
      `&fb_exchange_token=${refreshToken}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      throw new PlatformError("facebook", data.error.message);
    }

    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 5184000) * 1000),
      scopes: ["pages_manage_posts", "pages_read_engagement"],
    };
  }

  async getAccount(accessToken: string): Promise<PlatformAccount> {
    // Try to get user's pages first (include access_token field for page token)
    const pagesRes = await fetch(
      `${META_API_BASE}/me/accounts?fields=id,name,category,picture,access_token&access_token=${accessToken}`
    );
    const pagesData = await pagesRes.json();

    if (pagesData.error) {
      throw new PlatformError("facebook", pagesData.error.message);
    }

    const page = pagesData.data?.[0];
    if (page) {
      return {
        platformAccountId: page.id,
        accountName: page.name,
        accountType: "page",
        avatarUrl: page.picture?.data?.url,
        pageAccessToken: page.access_token,
      };
    }

    // No pages found - connect with user profile instead
    const profileRes = await fetch(
      `${META_API_BASE}/me?fields=id,name,picture.width(200)&access_token=${accessToken}`
    );
    const profile = await profileRes.json();

    if (profile.error) {
      throw new PlatformError("facebook", profile.error.message);
    }

    return {
      platformAccountId: profile.id,
      accountName: profile.name + " (perfil)",
      accountType: "profile",
      avatarUrl: profile.picture?.data?.url,
    };
  }

  async publishContent(
    accessToken: string,
    content: PlatformContent
  ): Promise<PublishResult> {
    const caption = `${content.caption}\n\n${content.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;

    // Use the page ID for endpoint (required for page publishing)
    const target = content.accountId ?? "me";

    let endpoint: string;
    let body: Record<string, string>;

    if (content.mediaUrl && content.mediaType === "image") {
      endpoint = `${META_API_BASE}/${target}/photos`;
      body = {
        url: content.mediaUrl,
        message: caption,
        access_token: accessToken,
      };
    } else if (content.mediaUrl && content.mediaType === "video") {
      endpoint = `${META_API_BASE}/${target}/videos`;
      body = {
        file_url: content.mediaUrl,
        description: caption,
        access_token: accessToken,
      };
    } else {
      endpoint = `${META_API_BASE}/${target}/feed`;
      body = {
        message: caption,
        access_token: accessToken,
      };
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (data.error) {
      throw new PlatformError("facebook", data.error.message, data.error);
    }

    const postId = data.id ?? data.post_id;
    return {
      platformPostId: postId,
      platformPostUrl: `https://www.facebook.com/${postId}`,
    };
  }

  async getPostMetrics(
    accessToken: string,
    postId: string
  ): Promise<PostMetrics> {
    let impressions = 0;
    let reach = 0;
    let engagedUsers = 0;

    // Determine if this is a Page post (PAGEID_POSTID) or standalone (Photo/Video)
    const isPagePost = postId.includes("_");

    // Try Page post insights (only works for page feed posts, not photos/videos)
    if (isPagePost) {
      try {
        const fields =
          "post_impressions,post_impressions_unique,post_engaged_users";
        const res = await fetch(
          `${META_API_BASE}/${postId}/insights?metric=${fields}&access_token=${accessToken}`
        );
        const data = await res.json();

        if (data.error) {
          console.log(
            `[FB Metrics] Insights error for ${postId}:`,
            data.error.message,
            `(code: ${data.error.code})`
          );
        } else if (data.data) {
          const metrics: Record<string, number> = {};
          for (const item of data.data) {
            const val = item.values?.[0]?.value;
            if (typeof val === "number") {
              metrics[item.name] = val;
            } else if (typeof val === "object" && val !== null) {
              metrics[item.name] = Object.values(val).reduce(
                (sum: number, v) => sum + (typeof v === "number" ? v : 0),
                0
              );
            }
          }
          impressions = metrics.post_impressions ?? 0;
          reach = metrics.post_impressions_unique ?? 0;
          engagedUsers = metrics.post_engaged_users ?? 0;
          console.log(
            `[FB Metrics] Insights for ${postId}: impressions=${impressions}, reach=${reach}, engaged=${engagedUsers}`
          );
        }
      } catch (err) {
        console.log(
          `[FB Metrics] Insights fetch failed for ${postId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Fetch social engagement — try with shares first, fallback without for Photo nodes
    let likes = 0;
    let comments = 0;
    let shares = 0;
    try {
      // Page posts support shares, Photos do not
      const fieldsWithShares = "reactions.limit(0).summary(true),comments.limit(0).summary(true),shares";
      const fieldsNoShares = "reactions.limit(0).summary(true),comments.limit(0).summary(true)";

      let socialRes = await fetch(
        `${META_API_BASE}/${postId}?fields=${isPagePost ? fieldsWithShares : fieldsNoShares}&access_token=${accessToken}`
      );
      let socialData = await socialRes.json();

      // If shares field fails, retry without it
      if (socialData.error?.message?.includes("nonexisting field")) {
        console.log(`[FB Metrics] Retrying ${postId} without shares field`);
        socialRes = await fetch(
          `${META_API_BASE}/${postId}?fields=${fieldsNoShares}&access_token=${accessToken}`
        );
        socialData = await socialRes.json();
      }

      if (socialData.error) {
        console.log(
          `[FB Metrics] Social counts error for ${postId}:`,
          socialData.error.message,
          `(code: ${socialData.error.code})`
        );
      } else {
        likes = socialData.reactions?.summary?.total_count ?? 0;
        comments = socialData.comments?.summary?.total_count ?? 0;
        shares = socialData.shares?.count ?? 0;
        console.log(
          `[FB Metrics] Social for ${postId}: likes=${likes}, comments=${comments}, shares=${shares}`
        );
      }
    } catch (err) {
      console.log(
        `[FB Metrics] Social fetch failed for ${postId}:`,
        err instanceof Error ? err.message : err
      );
    }

    // Use social interactions as fallback view count if insights unavailable
    const totalInteractions = likes + comments + shares;
    if (impressions === 0 && totalInteractions > 0) {
      impressions = totalInteractions;
    }

    return {
      views: impressions,
      likes,
      comments,
      shares,
      saves: 0,
      watchTimeSeconds: 0,
      avgWatchPercent: 0,
      reachUnique: reach,
      impressions,
      engagementRate: reach > 0 ? (engagedUsers / reach) * 100 : 0,
    };
  }

  async getAccountMetrics(
    accessToken: string,
    accountId: string
  ): Promise<AccountMetrics> {
    const res = await fetch(
      `${META_API_BASE}/${accountId}?fields=followers_count,fan_count&access_token=${accessToken}`
    );
    const data = await res.json();

    if (data.error) {
      throw new PlatformError("facebook", data.error.message);
    }

    return {
      followers: data.followers_count ?? data.fan_count ?? 0,
      followersGrowth: 0,
      totalViews: 0,
      totalWatchMinutes: 0,
      avgEngagementRate: 0,
    };
  }
}
