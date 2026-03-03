import { connectDB } from "@/lib/db/mongoose";
import SocialAccount from "@/lib/db/models/social-account.model";
import Publication from "@/lib/db/models/publication.model";
import MetricsSnapshot from "@/lib/db/models/metrics-snapshot.model";
import { socialPublisher } from "./publisher";
import { getDecryptedToken } from "./oauth-manager";

const META_API_BASE = "https://graph.facebook.com/v21.0";

interface PostSyncDetail {
  postId: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

interface SyncResult {
  synced: number;
  failed: number;
  discovered: number;
  errors: string[];
  details?: PostSyncDetail[];
}

/**
 * Discover posts from the Facebook page/profile feed and create Publication
 * records for any posts not already tracked in our database.
 */
async function discoverFacebookPosts(
  userId: string,
  platformAccountId: string,
  socialAccountId: string,
  accessToken: string
): Promise<number> {
  let discovered = 0;

  try {
    // Fetch recent posts from the page/profile feed
    const feedRes = await fetch(
      `${META_API_BASE}/${platformAccountId}/feed?fields=id,message,created_time,type,permalink_url&limit=50&access_token=${accessToken}`
    );
    const feedData = await feedRes.json();

    if (feedData.error || !feedData.data) {
      console.log(
        `[MetricsSync] Feed fetch for ${platformAccountId}:`,
        feedData.error?.message ?? "no data"
      );
      return 0;
    }

    for (const post of feedData.data) {
      // Check if we already have this post tracked
      const existing = await Publication.findOne({
        platformPostId: post.id,
      });

      if (!existing) {
        await Publication.create({
          userId,
          contentId: undefined,
          socialAccountId,
          platform: "facebook",
          status: "published",
          publishedAt: new Date(post.created_time),
          platformPostId: post.id,
          platformPostUrl:
            post.permalink_url ??
            `https://www.facebook.com/${post.id}`,
        });
        discovered++;
      }
    }
  } catch (err) {
    console.error("[MetricsSync] Discovery error:", err);
  }

  return discovered;
}

/**
 * Sync post-level metrics from Facebook for published posts.
 * First discovers unknown posts from the page feed, then syncs metrics for all.
 */
export async function syncPostMetrics(
  userId: string,
  accountId?: string
): Promise<SyncResult> {
  await connectDB();

  const accountFilter: Record<string, unknown> = {
    userId,
    isActive: true,
    platform: "facebook",
  };
  if (accountId) accountFilter._id = accountId;

  const accounts = await SocialAccount.find(accountFilter).select(
    "_id platform platformAccountId"
  );
  const result: SyncResult = { synced: 0, failed: 0, discovered: 0, errors: [], details: [] };

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  for (const account of accounts) {
    let accessToken: string;
    try {
      accessToken = await getDecryptedToken(account._id.toString());
      console.log(`[MetricsSync] Token obtained for account ${account._id} (page: ${account.platformAccountId})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Token error (${account._id}): ${msg}`);
      result.failed++;
      continue;
    }

    // Step 1: Discover posts from the Facebook page feed
    const discovered = await discoverFacebookPosts(
      userId,
      account.platformAccountId,
      account._id.toString(),
      accessToken
    );
    result.discovered += discovered;

    // Step 1.5: Fix orphaned publications (wrong userId from previous sessions)
    await Publication.updateMany(
      { socialAccountId: account._id, userId: { $ne: userId } },
      { $set: { userId } }
    );

    // Step 2: Sync metrics for ALL known publications (including newly discovered)
    const publications = await Publication.find({
      socialAccountId: account._id,
      status: "published",
      platformPostId: { $exists: true, $ne: null },
      publishedAt: { $gte: ninetyDaysAgo },
    });

    console.log(`[MetricsSync] Found ${publications.length} publications to sync for account ${account.platformAccountId}`);

    for (const pub of publications) {
      try {
        const metrics = await socialPublisher.getPostMetrics(
          "facebook",
          accessToken,
          pub.platformPostId!
        );

        console.log(
          `[MetricsSync] Post ${pub.platformPostId}: views=${metrics.views}, likes=${metrics.likes}, comments=${metrics.comments}, shares=${metrics.shares}`
        );

        await Publication.findByIdAndUpdate(pub._id, {
          $set: {
            "metrics.views": metrics.views,
            "metrics.likes": metrics.likes,
            "metrics.comments": metrics.comments,
            "metrics.shares": metrics.shares,
            "metrics.saves": metrics.saves,
            "metrics.watchTimeSeconds": metrics.watchTimeSeconds,
            "metrics.avgWatchPercent": metrics.avgWatchPercent,
            "metrics.reachUnique": metrics.reachUnique,
            "metrics.impressions": metrics.impressions,
            "metrics.engagementRate": metrics.engagementRate,
            "metrics.lastSyncAt": new Date(),
          },
        });

        result.details!.push({
          postId: pub.platformPostId!,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments,
          shares: metrics.shares,
        });

        result.synced++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Post ${pub.platformPostId}: ${msg}`);
        result.failed++;
      }
    }
  }

  return result;
}

/**
 * Sync account-level metrics (followers, views) and create daily snapshots.
 */
export async function syncAccountMetrics(
  userId: string,
  accountId?: string
): Promise<SyncResult> {
  await connectDB();

  const accountFilter: Record<string, unknown> = {
    userId,
    isActive: true,
    platform: "facebook",
  };
  if (accountId) accountFilter._id = accountId;

  const accounts = await SocialAccount.find(accountFilter);
  const result: SyncResult = { synced: 0, failed: 0, discovered: 0, errors: [] };

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const account of accounts) {
    try {
      const accessToken = await getDecryptedToken(account._id.toString());

      // Fetch account metrics from Facebook
      const accountMetrics = await socialPublisher.getAccountMetrics(
        "facebook",
        accessToken,
        account.platformAccountId
      );

      // Aggregate post metrics for this account (last 30 days)
      const pubAgg = await Publication.aggregate([
        {
          $match: {
            socialAccountId: account._id,
            status: "published",
            publishedAt: { $gte: thirtyDaysAgo },
          },
        },
        {
          $group: {
            _id: null,
            totalViews: { $sum: "$metrics.views" },
            totalLikes: { $sum: "$metrics.likes" },
            avgEngagement: { $avg: "$metrics.engagementRate" },
            count: { $sum: 1 },
          },
        },
      ]);

      const agg = pubAgg[0] ?? {
        totalViews: 0,
        totalLikes: 0,
        avgEngagement: 0,
        count: 0,
      };

      // Get previous snapshot for followers growth calculation
      const prevSnapshot = await MetricsSnapshot.findOne({
        socialAccountId: account._id,
      }).sort({ date: -1 });

      const followersGrowth = prevSnapshot
        ? accountMetrics.followers - prevSnapshot.followers
        : 0;

      // Aggregate by content type
      const contentTypePubs = await Publication.aggregate([
        {
          $match: {
            socialAccountId: account._id,
            status: "published",
            publishedAt: { $gte: thirtyDaysAgo },
          },
        },
        {
          $lookup: {
            from: "generatedcontents",
            localField: "contentId",
            foreignField: "_id",
            as: "content",
          },
        },
        { $unwind: { path: "$content", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: "$content.contentType",
            views: { $sum: "$metrics.views" },
            engagement: { $avg: "$metrics.engagementRate" },
          },
        },
      ]);

      const byContentType = {
        reels: { views: 0, engagement: 0 },
        videos: { views: 0, engagement: 0 },
        images: { views: 0, engagement: 0 },
      };
      for (const ct of contentTypePubs) {
        if (ct._id === "reel" || ct._id === "story") {
          byContentType.reels.views += ct.views;
          byContentType.reels.engagement = ct.engagement;
        } else if (ct._id === "video") {
          byContentType.videos.views += ct.views;
          byContentType.videos.engagement = ct.engagement;
        } else {
          byContentType.images.views += ct.views;
          byContentType.images.engagement = ct.engagement;
        }
      }

      // Upsert today's snapshot
      await MetricsSnapshot.findOneAndUpdate(
        { socialAccountId: account._id, date: today },
        {
          $set: {
            followers: accountMetrics.followers,
            followersGrowth,
            totalViews: agg.totalViews,
            totalWatchMinutes: 0,
            avgEngagementRate: agg.avgEngagement,
            postsPublished: agg.count,
            byContentType,
          },
        },
        { upsert: true }
      );

      // Update social account monetization + recent snapshots
      await SocialAccount.findByIdAndUpdate(account._id, {
        $set: {
          "monetization.currentFollowers": accountMetrics.followers,
          "monetization.currentViews30d": agg.totalViews,
          "monetization.lastSyncAt": new Date(),
        },
        $push: {
          recentSnapshots: {
            $each: [
              {
                date: new Date(),
                followers: accountMetrics.followers,
                views: agg.totalViews,
                watchMinutes: 0,
                engagementRate: agg.avgEngagement,
              },
            ],
            $sort: { date: -1 as const },
            $slice: 30,
          },
        },
      });

      result.synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Account ${account.accountName}: ${msg}`);
      result.failed++;
    }
  }

  return result;
}

/**
 * Sync all metrics (posts + accounts) for a specific user.
 */
export async function syncAllMetrics(
  userId: string,
  accountId?: string
) {
  const posts = await syncPostMetrics(userId, accountId);
  const accounts = await syncAccountMetrics(userId, accountId);
  return {
    posts,
    accounts,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Cron: sync metrics for all users with active Facebook accounts.
 */
export async function syncAllMetricsCron() {
  await connectDB();
  const accounts = await SocialAccount.find({
    isActive: true,
    platform: "facebook",
  }).select("userId");

  const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];

  const results = [];
  for (const uid of userIds) {
    try {
      const result = await syncAllMetrics(uid);
      results.push({ userId: uid, ...result });
    } catch (err) {
      results.push({
        userId: uid,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
  return results;
}
