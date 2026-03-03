import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { connectDB } from "@/lib/db/mongoose";
import Publication from "@/lib/db/models/publication.model";
import MetricsSnapshot from "@/lib/db/models/metrics-snapshot.model";
import SocialAccount from "@/lib/db/models/social-account.model";
import { successResponse, errorResponse, AppError } from "@/lib/utils/errors";

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        errorResponse(new AppError("No autenticado", "AUTH_ERROR", 401)),
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get("accountId");
    const days = parseInt(searchParams.get("days") ?? "30", 10);

    await connectDB();

    const accounts = accountId
      ? await SocialAccount.find({
          _id: accountId,
          userId: session.user.id,
          isActive: true,
        })
          .select("-auth")
          .lean()
      : await SocialAccount.find({
          userId: session.user.id,
          isActive: true,
        })
          .select("-auth")
          .lean();

    if (accounts.length === 0) {
      return NextResponse.json(
        successResponse({ accounts: [], publications: [], snapshots: [] })
      );
    }

    const accountIds = accounts.map((a) => a._id);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [publications, snapshots] = await Promise.all([
      Publication.find({
        socialAccountId: { $in: accountIds },
        status: "published",
        publishedAt: { $gte: since },
      })
        .sort({ publishedAt: -1 })
        .select("platform metrics publishedAt platformPostUrl")
        .lean(),
      MetricsSnapshot.find({
        socialAccountId: { $in: accountIds },
        date: { $gte: since },
      })
        .sort({ date: 1 })
        .lean(),
    ]);

    const accountsSummary = accounts.map((a) => ({
      id: a._id.toString(),
      platform: a.platform,
      accountName: a.accountName,
      avatarUrl: a.avatarUrl,
      monetization: a.monetization,
    }));

    const pubsFormatted = publications.map((p) => ({
      id: p._id.toString(),
      platform: p.platform,
      metrics: p.metrics,
      publishedAt: p.publishedAt,
      platformPostUrl: p.platformPostUrl,
    }));

    const snapsFormatted = snapshots.map((s) => ({
      id: s._id.toString(),
      accountId: s.socialAccountId.toString(),
      date: s.date,
      followers: s.followers,
      followersGrowth: s.followersGrowth,
      totalViews: s.totalViews,
      totalWatchMinutes: s.totalWatchMinutes,
      avgEngagementRate: s.avgEngagementRate,
      postsPublished: s.postsPublished,
      byContentType: s.byContentType,
    }));

    return NextResponse.json(
      successResponse({
        accounts: accountsSummary,
        publications: pubsFormatted,
        snapshots: snapsFormatted,
      })
    );
  } catch (error) {
    return NextResponse.json(
      errorResponse(
        error instanceof Error ? error : new Error("Error desconocido")
      ),
      { status: 500 }
    );
  }
}
