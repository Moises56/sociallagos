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
    // Step 1: Exchange code for short-lived user token
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

    const shortLivedUserToken = data.access_token;

    // Step 2: Try to get page access token with short-lived user token
    // (more reliable than long-lived token for /me/accounts in some cases)
    let pageAccessToken: string | null = null;
    try {
      const pagesRes = await fetch(
        `${META_API_BASE}/me/accounts?fields=id,name,access_token&access_token=${shortLivedUserToken}`
      );
      const pagesData = await pagesRes.json();
      pageAccessToken = pagesData.data?.[0]?.access_token ?? null;
      console.log(
        `[FB handleCallback] Short-lived token /me/accounts: pages=${pagesData.data?.length ?? 0}, hasPageToken=${!!pageAccessToken}`
      );
    } catch (err) {
      console.log(
        `[FB handleCallback] Failed to fetch pages with short-lived token:`,
        err instanceof Error ? err.message : err
      );
    }

    // Step 3: Exchange for long-lived token
    // If we got a page token, exchange THAT (produces a non-expiring page token)
    // Otherwise exchange the user token
    const tokenToExchange = pageAccessToken ?? shortLivedUserToken;
    const longLivedUrl =
      `${META_API_BASE}/oauth/access_token?` +
      `grant_type=fb_exchange_token` +
      `&client_id=${this.appId}` +
      `&client_secret=${this.appSecret}` +
      `&fb_exchange_token=${tokenToExchange}`;

    const longRes = await fetch(longLivedUrl);
    const longData = await longRes.json();

    if (longData.error) {
      // If page token exchange fails, fall back to user token exchange
      if (pageAccessToken) {
        console.log(
          `[FB handleCallback] Page token exchange failed, falling back to user token:`,
          longData.error.message
        );
        const fallbackUrl =
          `${META_API_BASE}/oauth/access_token?` +
          `grant_type=fb_exchange_token` +
          `&client_id=${this.appId}` +
          `&client_secret=${this.appSecret}` +
          `&fb_exchange_token=${shortLivedUserToken}`;
        const fallbackRes = await fetch(fallbackUrl);
        const fallbackData = await fallbackRes.json();

        if (fallbackData.error) {
          throw new PlatformError("facebook", fallbackData.error.message);
        }

        return {
          accessToken: fallbackData.access_token,
          expiresAt: new Date(
            Date.now() + (fallbackData.expires_in ?? 5184000) * 1000
          ),
          scopes: ["pages_manage_posts", "pages_read_engagement"],
        };
      }
      throw new PlatformError("facebook", longData.error.message);
    }

    console.log(
      `[FB handleCallback] Token exchanged successfully, usedPageToken=${!!pageAccessToken}`
    );

    return {
      accessToken: longData.access_token,
      expiresAt: new Date(Date.now() + (longData.expires_in ?? 5184000) * 1000),
      scopes: ["pages_manage_posts", "pages_read_engagement"],
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

    console.log(
      `[FB getAccount] /me/accounts response:`,
      JSON.stringify({
        error: pagesData.error ?? null,
        dataLength: pagesData.data?.length ?? 0,
        pages: pagesData.data?.map((p: { id: string; name: string }) => ({
          id: p.id,
          name: p.name,
        })),
      })
    );

    if (pagesData.error) {
      throw new PlatformError("facebook", pagesData.error.message);
    }

    const page = pagesData.data?.[0];
    if (page) {
      console.log(
        `[FB getAccount] Using page: id=${page.id}, name=${page.name}, hasPageToken=${!!page.access_token}`
      );
      return {
        platformAccountId: page.id,
        accountName: page.name,
        accountType: "page",
        avatarUrl: page.picture?.data?.url,
        pageAccessToken: page.access_token,
      };
    }

    // /me/accounts returned empty — token might already be a page access token
    // (happens when handleCallback exchanged a page token for long-lived)
    console.log(`[FB getAccount] /me/accounts empty, trying /me as page token fallback`);

    // Get basic info (safe fields that work for both pages and profiles)
    const meRes = await fetch(
      `${META_API_BASE}/me?fields=id,name,picture.width(200)&access_token=${accessToken}`
    );
    const meData = await meRes.json();

    if (meData.error) {
      throw new PlatformError("facebook", meData.error.message);
    }

    // Detect if this is a page by trying page-specific fields
    // Try multiple fields since "New Pages Experience" may not support all of them
    let isPage = false;
    const pageFields = ["fan_count", "category", "category_list"];
    for (const field of pageFields) {
      try {
        const typeRes = await fetch(
          `${META_API_BASE}/${meData.id}?fields=${field}&access_token=${accessToken}`
        );
        const typeData = await typeRes.json();
        if (!typeData.error) {
          isPage = true;
          console.log(
            `[FB getAccount] Page detected via '${field}' for ${meData.id} (${meData.name})`
          );
          break;
        }
        console.log(
          `[FB getAccount] Field '${field}' unavailable for ${meData.id}: ${typeData.error?.message}`
        );
      } catch {
        // Continue to next field
      }
    }

    if (isPage) {
      return {
        platformAccountId: meData.id,
        accountName: meData.name,
        accountType: "page",
        avatarUrl: meData.picture?.data?.url,
      };
    }

    // It's a personal profile — not supported for publishing
    console.log(
      `[FB getAccount] No pages found and token is for profile ${meData.id} (${meData.name}) — cannot connect`
    );
    throw new PlatformError(
      "facebook",
      "No se encontraron Páginas de Facebook. SocialForge requiere una Página para publicar. Crea una en facebook.com/pages/create y vuelve a conectar."
    );
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

    // Fetch social engagement with progressive fallback:
    // 1. reactions + comments + shares (page posts)
    // 2. reactions + comments (photos)
    // 3. likes + comments (reels/videos that don't support reactions)
    let likes = 0;
    let comments = 0;
    let shares = 0;
    try {
      const fieldSets = isPagePost
        ? [
            "reactions.limit(0).summary(true),comments.limit(0).summary(true),shares",
            "reactions.limit(0).summary(true),comments.limit(0).summary(true)",
            "likes.limit(0).summary(true),comments.limit(0).summary(true)",
          ]
        : [
            "reactions.limit(0).summary(true),comments.limit(0).summary(true)",
            "likes.limit(0).summary(true),comments.limit(0).summary(true)",
          ];

      let socialData: Record<string, unknown> = {};
      for (const fields of fieldSets) {
        const socialRes = await fetch(
          `${META_API_BASE}/${postId}?fields=${fields}&access_token=${accessToken}`
        );
        socialData = await socialRes.json();

        if (!(socialData as { error?: unknown }).error) break;

        const errMsg = ((socialData as { error?: { message?: string } }).error?.message) ?? "";
        console.log(`[FB Metrics] Fields "${fields}" failed for ${postId}: ${errMsg}`);

        // Only retry on "nonexisting field" errors; permission errors won't fix with different fields
        if (!errMsg.includes("nonexisting field")) break;
      }

      if ((socialData as { error?: { message?: string } }).error) {
        console.log(
          `[FB Metrics] Social counts error for ${postId}:`,
          (socialData as { error?: { message?: string } }).error?.message,
        );
      } else {
        // reactions or likes — whichever is available
        const reactionsCount = (socialData as { reactions?: { summary?: { total_count?: number } } }).reactions?.summary?.total_count;
        const likesCount = (socialData as { likes?: { summary?: { total_count?: number } } }).likes?.summary?.total_count;
        likes = reactionsCount ?? likesCount ?? 0;
        comments = (socialData as { comments?: { summary?: { total_count?: number } } }).comments?.summary?.total_count ?? 0;
        shares = (socialData as { shares?: { count?: number } }).shares?.count ?? 0;
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
