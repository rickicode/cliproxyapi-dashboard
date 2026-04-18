import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export interface OAuthOwnershipResolverOwnership {
  id: string;
  userId: string;
  provider: string;
  accountName: string;
  accountEmail?: string | null;
}

export interface OAuthOwnershipResolverFailure {
  code: string;
  message: string;
}

export interface ResolveOAuthOwnershipInput {
  currentUserId: string;
  provider: string;
  accountName: string;
  accountEmail?: string | null;
}

export type OAuthOwnershipResolution =
  | {
    kind: "claimed";
    ownership: OAuthOwnershipResolverOwnership;
  }
  | {
    kind: "already_owned_by_current_user";
    ownership: OAuthOwnershipResolverOwnership;
  }
  | {
    kind: "claimed_by_other_user";
    ownership: OAuthOwnershipResolverOwnership;
  }
  | {
    kind: "merged_with_existing";
    ownership: OAuthOwnershipResolverOwnership;
  }
  | {
    kind: "ambiguous";
    ownerships: OAuthOwnershipResolverOwnership[];
  }
  | {
    kind: "error";
    failure: OAuthOwnershipResolverFailure;
  };

function normalizeEmail(email?: string | null): string | null {
  if (typeof email !== "string") return null;

  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getUpdatedAccountEmail(
  existingEmail?: string | null,
  incomingEmail?: string | null
): string | null {
  const normalizedIncomingEmail = normalizeEmail(incomingEmail);
  if (normalizedIncomingEmail !== null) {
    return normalizedIncomingEmail;
  }

  return normalizeEmail(existingEmail);
}

function toFailure(error: unknown): OAuthOwnershipResolverFailure {
  if (error instanceof Error && error.message) {
    return {
      code: "oauth_ownership_resolution_failed",
      message: error.message,
    };
  }

  return {
    code: "oauth_ownership_resolution_failed",
    message: "Failed to resolve OAuth ownership",
  };
}

export async function resolveOAuthOwnership({
  currentUserId,
  provider,
  accountName,
  accountEmail,
}: ResolveOAuthOwnershipInput): Promise<OAuthOwnershipResolution> {
  const normalizedEmail = normalizeEmail(accountEmail);

  try {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const exactMatch = await tx.providerOAuthOwnership.findUnique({
        where: {
          provider_accountName: {
            provider,
            accountName,
          },
        },
      });

      if (exactMatch) {
        if (exactMatch.userId !== currentUserId) {
          return {
            kind: "claimed_by_other_user",
            ownership: exactMatch,
          } satisfies OAuthOwnershipResolution;
        }

        if (normalizeEmail(exactMatch.accountEmail) === normalizedEmail) {
          return {
            kind: "already_owned_by_current_user",
            ownership: exactMatch,
          } satisfies OAuthOwnershipResolution;
        }

        const mergedOwnership = await tx.providerOAuthOwnership.update({
          where: { id: exactMatch.id },
          data: {
            accountName,
            accountEmail: getUpdatedAccountEmail(exactMatch.accountEmail, accountEmail),
          },
        });

        return {
          kind: "merged_with_existing",
          ownership: mergedOwnership,
        } satisfies OAuthOwnershipResolution;
      }

      const fallbackMatches = normalizedEmail
        ? await tx.providerOAuthOwnership.findMany({
          where: {
            provider,
            accountEmail: normalizedEmail,
          },
        })
        : [];

      if (fallbackMatches.length > 1) {
        return {
          kind: "ambiguous",
          ownerships: fallbackMatches,
        } satisfies OAuthOwnershipResolution;
      }

      if (fallbackMatches.length === 1) {
        const [matchedOwnership] = fallbackMatches;
        if (matchedOwnership.userId !== currentUserId) {
          return {
            kind: "claimed_by_other_user",
            ownership: matchedOwnership,
          } satisfies OAuthOwnershipResolution;
        }

        const updatedOwnership = await tx.providerOAuthOwnership.update({
          where: { id: matchedOwnership.id },
          data: {
            accountName,
            accountEmail: getUpdatedAccountEmail(matchedOwnership.accountEmail, accountEmail),
          },
        });

        return {
          kind: "merged_with_existing",
          ownership: updatedOwnership,
        } satisfies OAuthOwnershipResolution;
      }

      const createdOwnership = await tx.providerOAuthOwnership.create({
        data: {
          userId: currentUserId,
          provider,
          accountName,
          accountEmail: normalizedEmail,
        },
      });

      return {
        kind: "claimed",
        ownership: createdOwnership,
      } satisfies OAuthOwnershipResolution;
    });
  } catch (error) {
    return {
      kind: "error",
      failure: toFailure(error),
    };
  }
}
