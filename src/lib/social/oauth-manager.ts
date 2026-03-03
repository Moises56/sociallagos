import { connectDB } from "@/lib/db/mongoose";
import SocialAccount from "@/lib/db/models/social-account.model";
import { socialPublisher } from "./publisher";
import { encrypt, decrypt } from "@/lib/utils/encryption";
import type { Platform } from "@/lib/utils/constants";
import { MONETIZATION_REQUIREMENTS } from "@/lib/utils/constants";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export function getRedirectUri(platform: Platform): string {
  return `${APP_URL}/api/social/callback/${platform}`;
}

export async function initiateOAuth(platform: Platform, userId: string) {
  const redirectUri = getRedirectUri(platform);
  return socialPublisher.getAuthUrl(platform, userId, redirectUri);
}

export async function completeOAuth(
  platform: Platform,
  code: string,
  userId: string
) {
  const redirectUri = getRedirectUri(platform);

  // Exchange code for tokens
  const tokens = await socialPublisher.handleCallback(
    platform,
    code,
    redirectUri
  );

  // Get account info
  const account = await socialPublisher.getAccount(
    platform,
    tokens.accessToken
  );

  await connectDB();

  // For Facebook Pages, use the page-specific access token instead of user token
  const tokenToStore = account.pageAccessToken ?? tokens.accessToken;

  // Encrypt tokens before storing
  const encryptedAccess = encrypt(tokenToStore);
  const encryptedRefresh = tokens.refreshToken
    ? encrypt(tokens.refreshToken)
    : undefined;

  // Determine monetization targets
  const requirements =
    MONETIZATION_REQUIREMENTS[platform as keyof typeof MONETIZATION_REQUIREMENTS];
  const targetFollowers =
    "followers" in requirements ? requirements.followers : 10000;
  const targetViews =
    "views30d" in requirements ? requirements.views30d : 100000;
  const targetWatchMinutes =
    "watchMinutes60d" in requirements ? requirements.watchMinutes60d : 600000;

  // Upsert social account (match by platform+platformAccountId to avoid duplicate key errors)
  const socialAccount = await SocialAccount.findOneAndUpdate(
    {
      platform,
      platformAccountId: account.platformAccountId,
    },
    {
      $set: {
        userId,
        accountName: account.accountName,
        accountType: account.accountType,
        avatarUrl: account.avatarUrl,
        auth: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          tokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
        },
        "monetization.targetFollowers": targetFollowers,
        "monetization.targetViews": targetViews,
        "monetization.targetWatchMinutes": targetWatchMinutes,
        "monetization.lastSyncAt": new Date(),
        isActive: true,
        connectedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  return socialAccount;
}

export async function getDecryptedToken(
  socialAccountId: string
): Promise<string> {
  await connectDB();
  const account = await SocialAccount.findById(socialAccountId);
  if (!account) throw new Error("Cuenta social no encontrada");
  return decrypt(account.auth.accessToken);
}

export async function disconnectAccount(
  socialAccountId: string,
  userId: string
) {
  await connectDB();
  const result = await SocialAccount.findOneAndUpdate(
    { _id: socialAccountId, userId },
    { $set: { isActive: false } },
    { new: true }
  );
  return result;
}
