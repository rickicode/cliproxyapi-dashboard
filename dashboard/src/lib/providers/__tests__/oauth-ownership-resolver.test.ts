import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const mockTx = {
    providerOAuthOwnership: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockPrisma = {
    $transaction: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx)),
  };

  return { mockTx, mockPrisma };
});

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

import { resolveOAuthOwnership } from "@/lib/providers/oauth-ownership-resolver";

describe("resolveOAuthOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when create flow fails", async () => {
    const failure = new Error("db unavailable");
    mockPrisma.$transaction.mockRejectedValueOnce(failure);

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      })
    ).resolves.toEqual({
      kind: "error",
      failure: {
        code: "oauth_ownership_resolution_failed",
        message: "db unavailable",
      },
    });
  });

  it("creates a new ownership and returns claimed when no duplicate exists", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce(null);
    mockTx.providerOAuthOwnership.findMany.mockResolvedValueOnce([]);
    mockTx.providerOAuthOwnership.create.mockResolvedValueOnce({
      id: "ownership-1",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: " User@example.com ",
      })
    ).resolves.toEqual({
      kind: "claimed",
      ownership: {
        id: "ownership-1",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
  });

  it("returns already_owned_by_current_user when exact match already belongs to the current user", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce({
      id: "ownership-2",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: " User@example.com ",
      })
    ).resolves.toEqual({
      kind: "already_owned_by_current_user",
      ownership: {
        id: "ownership-2",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.update).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.create).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.findMany).not.toHaveBeenCalled();
  });

  it("merges exact accountName duplicates using the new auth when current user data changed", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce({
      id: "ownership-3",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: null,
    });
    mockTx.providerOAuthOwnership.update.mockResolvedValueOnce({
      id: "ownership-3",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "User@example.com",
      })
    ).resolves.toEqual({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-3",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "ownership-3" },
      data: {
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
    expect(mockTx.providerOAuthOwnership.findMany).not.toHaveBeenCalled();
  });

  it("does not clear an existing exact-match account email when the incoming email is omitted", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce({
      id: "ownership-3b",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
    });
    mockTx.providerOAuthOwnership.update.mockResolvedValueOnce({
      id: "ownership-3b",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: undefined,
      })
    ).resolves.toEqual({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-3b",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "ownership-3b" },
      data: {
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
    expect(mockTx.providerOAuthOwnership.findMany).not.toHaveBeenCalled();
  });

  it("returns claimed_by_other_user for an exact accountName match owned by another user", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce({
      id: "ownership-4",
      userId: "user-2",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      })
    ).resolves.toEqual({
      kind: "claimed_by_other_user",
      ownership: {
        id: "ownership-4",
        userId: "user-2",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.update).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.create).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.findMany).not.toHaveBeenCalled();
  });

  it("returns ambiguous for an exact accountName match when the provider differs", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce({
      id: "ownership-4b",
      userId: "user-2",
      provider: "gemini",
      accountName: "claude_user@example.com.json",
      accountEmail: "other@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      })
    ).resolves.toEqual({
      kind: "ambiguous",
      ownerships: [
        {
          id: "ownership-4b",
          userId: "user-2",
          provider: "gemini",
          accountName: "claude_user@example.com.json",
          accountEmail: "other@example.com",
        },
      ],
    });

    expect(mockTx.providerOAuthOwnership.findMany).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.create).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.update).not.toHaveBeenCalled();
  });

  it("prefers an exact accountName match even when a unique normalized-email fallback candidate would conflict", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce({
      id: "ownership-4a",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "old-email@example.com",
    });
    mockTx.providerOAuthOwnership.update.mockResolvedValueOnce({
      id: "ownership-4a",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: " user@example.com ",
      })
    ).resolves.toEqual({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-4a",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "ownership-4a" },
      data: {
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
    expect(mockTx.providerOAuthOwnership.findMany).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.create).not.toHaveBeenCalled();
  });

  it("merges a unique provider+normalized-email fallback match using the new auth", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce(null);
    mockTx.providerOAuthOwnership.findMany.mockResolvedValueOnce([
      {
        id: "ownership-5",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_old_user@example.com.json",
        accountEmail: "user@example.com",
      },
    ]);
    mockTx.providerOAuthOwnership.update.mockResolvedValueOnce({
      id: "ownership-5",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_new_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_new_user@example.com.json",
        accountEmail: " User@example.com ",
      })
    ).resolves.toEqual({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-5",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_new_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.findMany).toHaveBeenCalledWith({
      where: {
        provider: "claude",
        accountEmail: "user@example.com",
      },
    });
    expect(mockTx.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "ownership-5" },
      data: {
        accountName: "claude_new_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
  });

  it("preserves the normalized fallback-match account email while merging the new account name", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce(null);
    mockTx.providerOAuthOwnership.findMany.mockResolvedValueOnce([
      {
        id: "ownership-5b",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_old_user@example.com.json",
        accountEmail: "user@example.com",
      },
    ]);
    mockTx.providerOAuthOwnership.update.mockResolvedValueOnce({
      id: "ownership-5b",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_new_user@example.com.json",
      accountEmail: "user@example.com",
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_new_user@example.com.json",
        accountEmail: " User@Example.com ",
      })
    ).resolves.toEqual({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-5b",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_new_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "ownership-5b" },
      data: {
        accountName: "claude_new_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
    expect(mockTx.providerOAuthOwnership.findMany).toHaveBeenCalledWith({
      where: {
        provider: "claude",
        accountEmail: "user@example.com",
      },
    });
  });

  it("returns ambiguous when normalized-email fallback finds multiple matches", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce(null);
    mockTx.providerOAuthOwnership.findMany.mockResolvedValueOnce([
      {
        id: "ownership-6",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_old_a@example.com.json",
        accountEmail: "user@example.com",
      },
      {
        id: "ownership-7",
        userId: "user-2",
        provider: "claude",
        accountName: "claude_old_b@example.com.json",
        accountEmail: "user@example.com",
      },
    ]);

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_new_user@example.com.json",
        accountEmail: "user@example.com",
      })
    ).resolves.toEqual({
      kind: "ambiguous",
      ownerships: [
        {
          id: "ownership-6",
          userId: "user-1",
          provider: "claude",
          accountName: "claude_old_a@example.com.json",
          accountEmail: "user@example.com",
        },
        {
          id: "ownership-7",
          userId: "user-2",
          provider: "claude",
          accountName: "claude_old_b@example.com.json",
          accountEmail: "user@example.com",
        },
      ],
    });

    expect(mockTx.providerOAuthOwnership.update).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.create).not.toHaveBeenCalled();
  });

  it("returns claimed_by_other_user for a unique email fallback owned by another user", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce(null);
    mockTx.providerOAuthOwnership.findMany.mockResolvedValueOnce([
      {
        id: "ownership-8",
        userId: "user-2",
        provider: "claude",
        accountName: "claude_old_user@example.com.json",
        accountEmail: "user@example.com",
      },
    ]);
    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_new_user@example.com.json",
        accountEmail: "user@example.com",
      })
    ).resolves.toEqual({
      kind: "claimed_by_other_user",
      ownership: {
        id: "ownership-8",
        userId: "user-2",
        provider: "claude",
        accountName: "claude_old_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    expect(mockTx.providerOAuthOwnership.update).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.create).not.toHaveBeenCalled();
  });

  it("skips normalized-email fallback when accountEmail is blank and creates a fresh claim", async () => {
    mockTx.providerOAuthOwnership.findUnique.mockResolvedValueOnce(null);
    mockTx.providerOAuthOwnership.create.mockResolvedValueOnce({
      id: "ownership-9",
      userId: "user-1",
      provider: "claude",
      accountName: "claude_no_email@example.com.json",
      accountEmail: null,
    });

    await expect(
      resolveOAuthOwnership({
        currentUserId: "user-1",
        provider: "claude",
        accountName: "claude_no_email@example.com.json",
        accountEmail: "   ",
      })
    ).resolves.toEqual({
      kind: "claimed",
      ownership: {
        id: "ownership-9",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_no_email@example.com.json",
        accountEmail: null,
      },
    });

    expect(mockTx.providerOAuthOwnership.findMany).not.toHaveBeenCalled();
    expect(mockTx.providerOAuthOwnership.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        provider: "claude",
        accountName: "claude_no_email@example.com.json",
        accountEmail: null,
      },
    });
  });
});
