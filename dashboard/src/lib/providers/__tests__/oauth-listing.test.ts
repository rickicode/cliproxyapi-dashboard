import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, findUniqueMock, deleteMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerOAuthOwnership: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
      delete: deleteMock,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/generated/prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code = "P2002";
    },
  },
}));

vi.mock("@/lib/cache", () => ({
  invalidateUsageCaches: vi.fn(),
  invalidateProxyModelsCache: vi.fn(),
}));

vi.mock("@/lib/providers/management-api", () => ({
  MANAGEMENT_BASE_URL: "http://localhost:8317",
  MANAGEMENT_API_KEY: "test-key",
  FETCH_TIMEOUT_MS: 1000,
  fetchWithTimeout: vi.fn(),
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
}));

import { buildOAuthListResponse } from "@/lib/providers/oauth-listing";
import {
  bulkUpdateOAuthAccounts,
  listOAuthAccounts,
  summarizeBulkOAuthAction,
} from "@/lib/providers/oauth-ops";
import { fetchWithTimeout } from "@/lib/providers/management-api";

const fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildOAuthListResponse", () => {
  const rows = [
    {
      id: "auth-1",
      rowKey: "auth-1",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
      provider: "claude",
      ownerUsername: "ricki",
      ownerUserId: "user-1",
      isOwn: true,
      status: "active",
      statusMessage: null,
      unavailable: false,
      actionKey: "claude_user@example.com.json",
      canToggle: true,
      canDelete: true,
      canClaim: false,
    },
    {
      id: "auth-2",
      rowKey: "auth-2",
      accountName: "cursor_other@example.com.json",
      accountEmail: "other@example.com",
      provider: "cursor",
      ownerUsername: null,
      ownerUserId: null,
      isOwn: false,
      status: "expired",
      statusMessage: '{"message":"Token expired"}',
      unavailable: true,
      actionKey: "cursor_other@example.com.json",
      canToggle: false,
      canDelete: false,
      canClaim: true,
    },
    {
      id: "auth-3",
      rowKey: "auth-3",
      accountName: "review_bot@example.com.json",
      accountEmail: "review@example.com",
      provider: "gemini",
      ownerUsername: "teammate",
      ownerUserId: "user-2",
      isOwn: false,
      status: "needs_review",
      statusMessage: '{"error":{"message":"Needs re-auth soon"}}',
      unavailable: false,
      actionKey: "review_bot@example.com.json",
      canToggle: false,
      canDelete: false,
      canClaim: false,
    },
  ] as const;

  it("filters by query across account, email, provider, status, and parsed status message text", () => {
    expect(
      buildOAuthListResponse([...rows], {
        q: "other@example.com",
        status: "all",
        page: 1,
        pageSize: 50,
        preview: false,
      }).items.map((row) => row.id)
    ).toEqual(["auth-2"]);

    expect(
      buildOAuthListResponse([...rows], {
        q: "gemini",
        status: "all",
        page: 1,
        pageSize: 50,
        preview: false,
      }).items.map((row) => row.id)
    ).toEqual(["auth-3"]);

    expect(
      buildOAuthListResponse([...rows], {
        q: "expired",
        status: "all",
        page: 1,
        pageSize: 50,
        preview: false,
      }).items.map((row) => row.id)
    ).toEqual(["auth-2"]);

    expect(
      buildOAuthListResponse([...rows], {
        q: "re-auth soon",
        status: "all",
        page: 1,
        pageSize: 50,
        preview: false,
      }).items.map((row) => row.id)
    ).toEqual(["auth-3"]);

    expect(
      buildOAuthListResponse([...rows], {
        q: "claude_user",
        status: "all",
        page: 1,
        pageSize: 50,
        preview: false,
      }).items.map((row) => row.id)
    ).toEqual(["auth-1"]);
  });

  it("filters by selected status and preserves unknown upstream statuses in availableStatuses", () => {
    const result = buildOAuthListResponse([...rows], {
      q: "",
      status: "needs_review",
      page: 1,
      pageSize: 50,
      preview: false,
    });

    expect(result.items.map((row) => row.id)).toEqual(["auth-3"]);
    expect(result.availableStatuses).toEqual(["active", "expired", "needs_review"]);
  });

  it("supports normal pagination without preview capping", () => {
    const pageRows = Array.from({ length: 25 }, (_, index) => ({
      ...rows[0],
      id: `page-${index + 1}`,
      rowKey: `page-${index + 1}`,
      accountName: `account-${index + 1}.json`,
      actionKey: `account-${index + 1}.json`,
    }));

    const result = buildOAuthListResponse(pageRows, {
      q: "",
      status: "all",
      page: 2,
      pageSize: 10,
      preview: false,
    });

    expect(result.items).toHaveLength(10);
    expect(result.items[0]?.id).toBe("page-11");
    expect(result.items[9]?.id).toBe("page-20");
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(3);
  });

  it("caps preview responses to ten items", () => {
    const previewRows = Array.from({ length: 12 }, (_, index) => ({
      ...rows[0],
      id: `preview-${index + 1}`,
      rowKey: `preview-${index + 1}`,
      accountName: `preview-${index + 1}.json`,
      actionKey: `preview-${index + 1}.json`,
    }));

    const result = buildOAuthListResponse(previewRows, {
      q: "",
      status: "all",
      page: 99,
      pageSize: 50,
      preview: true,
    });

    expect(result.items).toHaveLength(10);
    expect(result.items[0]?.id).toBe("preview-1");
    expect(result.items[9]?.id).toBe("preview-10");
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.total).toBe(12);
    expect(result.totalPages).toBe(1);
  });
});

describe("summarizeBulkOAuthAction", () => {
  it("returns partial-success summaries for mixed bulk results", () => {
    expect(
      summarizeBulkOAuthAction(["owned.json", "unowned.json", "missing.json"], [
        { actionKey: "unowned.json", reason: "Access denied" },
        { actionKey: "missing.json", reason: "Missing action key" },
      ])
    ).toEqual({
      total: 3,
      successCount: 1,
      failureCount: 2,
    });
  });
});

describe("listOAuthAccounts", () => {
  it("maps stable action keys and trustworthy capability flags from ownership and admin permissions", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          files: [
            {
              id: "mgmt-1",
              name: "owned@example.com.json",
              provider: "claude",
              email: "owned@example.com",
              status: "active",
            },
            {
              id: "mgmt-2",
              name: "unclaimed@example.com.json",
              provider: "cursor",
              email: "unclaimed@example.com",
              status: "expired",
            },
            {
              id: "mgmt-3",
              name: "teammate@example.com.json",
              provider: "gemini",
              email: "teammate@example.com",
              status: "active",
            },
          ],
        })
      )
    );
    findManyMock.mockResolvedValueOnce([
      {
        id: "ownership-1",
        provider: "claude",
        accountName: "owned@example.com.json",
        userId: "user-1",
        user: { id: "user-1", username: "ricki" },
      },
      {
        id: "ownership-2",
        provider: "gemini-cli",
        accountName: "teammate@example.com.json",
        userId: "user-2",
        user: { id: "user-2", username: "teammate" },
      },
    ]);

    const nonAdminResult = await listOAuthAccounts("user-1", false, {
      q: "",
      status: "all",
      page: 1,
      pageSize: 50,
      preview: false,
    });

    expect(nonAdminResult).toMatchObject({ ok: true });
    if (!nonAdminResult.ok) {
      throw new Error("Expected ok list result");
    }

    expect(nonAdminResult.data.items).toEqual([
      expect.objectContaining({
        id: "mgmt-1",
        accountName: "owned@example.com.json",
        actionKey: "oauth:claude:owned%40example.com.json:mgmt-1",
        rowKey: "oauth-row:claude:owned%40example.com.json:mgmt-1",
        canToggle: true,
        canDelete: true,
        canClaim: false,
      }),
      expect.objectContaining({
        id: "account-2",
        accountName: "Account 2",
        actionKey: "",
        canToggle: false,
        canDelete: false,
        canClaim: false,
      }),
      expect.objectContaining({
        id: "account-3",
        accountName: "Account 3",
        actionKey: "",
        canToggle: false,
        canDelete: false,
        canClaim: false,
      }),
    ]);

    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          files: [
            {
              id: "mgmt-1",
              name: "owned@example.com.json",
              provider: "claude",
              email: "owned@example.com",
              status: "active",
            },
            {
              id: "mgmt-2",
              name: "unclaimed@example.com.json",
              provider: "cursor",
              email: "unclaimed@example.com",
              status: "expired",
            },
            {
              id: "mgmt-3",
              name: "teammate@example.com.json",
              provider: "gemini",
              email: "teammate@example.com",
              status: "active",
            },
          ],
        })
      )
    );
    findManyMock.mockResolvedValueOnce([
      {
        id: "ownership-1",
        provider: "claude",
        accountName: "owned@example.com.json",
        userId: "user-1",
        user: { id: "user-1", username: "ricki" },
      },
      {
        id: "ownership-2",
        provider: "gemini-cli",
        accountName: "teammate@example.com.json",
        userId: "user-2",
        user: { id: "user-2", username: "teammate" },
      },
    ]);

    const adminResult = await listOAuthAccounts("admin-1", true, {
      q: "",
      status: "all",
      page: 1,
      pageSize: 50,
      preview: false,
    });

    expect(adminResult).toMatchObject({ ok: true });
    if (!adminResult.ok) {
      throw new Error("Expected ok admin list result");
    }

    expect(adminResult.data.items).toEqual([
      expect.objectContaining({
        accountName: "owned@example.com.json",
        actionKey: "oauth:claude:owned%40example.com.json:mgmt-1",
        canToggle: true,
        canDelete: true,
        canClaim: false,
      }),
      expect.objectContaining({
        accountName: "unclaimed@example.com.json",
        actionKey: "oauth:cursor:unclaimed%40example.com.json:mgmt-2",
        canToggle: true,
        canDelete: true,
        canClaim: true,
      }),
      expect.objectContaining({
        accountName: "teammate@example.com.json",
        actionKey: "oauth:gemini:teammate%40example.com.json:mgmt-3",
        canToggle: true,
        canDelete: true,
        canClaim: false,
      }),
    ]);
  });
});

describe("bulkUpdateOAuthAccounts", () => {
  it("skips ineligible bulk selections and reports partial-success failures without aborting", async () => {
    findUniqueMock.mockImplementation(
      async ({
        where,
      }: {
        where: { id?: string; accountName?: string; provider_accountName?: { provider: string; accountName: string } };
      }) => {
        if (where.id === "owned@example.com.json") {
          return null;
        }

        if (
          where.provider_accountName?.provider === "claude" &&
          where.provider_accountName.accountName === "owned@example.com.json"
        ) {
          return { id: "ownership-1", userId: "user-1", accountName: "owned@example.com.json" };
        }

        if (where.id === "teammate@example.com.json") {
          return null;
        }

        if (
          where.provider_accountName?.provider === "gemini-cli" &&
          where.provider_accountName.accountName === "teammate@example.com.json"
        ) {
          return { id: "ownership-2", userId: "user-2", accountName: "teammate@example.com.json" };
        }

        return null;
      }
    );
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await bulkUpdateOAuthAccounts("user-1", false, {
      action: "disable",
      actionKeys: [
        "oauth:claude:owned%40example.com.json:owned@example.com.json",
        "",
        "oauth:gemini:teammate%40example.com.json:teammate@example.com.json",
      ],
    });

    expect(result).toEqual({
      ok: true,
      summary: { total: 3, successCount: 1, failureCount: 2 },
      failures: [
        { actionKey: "", reason: "Missing action key" },
        {
          actionKey: "oauth:gemini:teammate%40example.com.json:teammate@example.com.json",
          reason: "Access denied",
        },
      ],
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "http://localhost:8317/auth-files?name=owned%40example.com.json&provider=claude",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "owned@example.com.json",
          provider: "claude",
          disabled: true,
        }),
      })
    );
  });

  it("supports disconnect bulk operations with the same partial-success behavior", async () => {
    findUniqueMock.mockImplementation(
      async ({
        where,
      }: {
        where: { id?: string; accountName?: string; provider_accountName?: { provider: string; accountName: string } };
      }) => {
        if (where.id === "owned@example.com.json") {
          return null;
        }

        if (
          where.provider_accountName?.provider === "claude" &&
          where.provider_accountName.accountName === "owned@example.com.json"
        ) {
          return { id: "ownership-1", userId: "user-1", accountName: "owned@example.com.json" };
        }

        if (where.id === "teammate@example.com.json") {
          return null;
        }

        if (
          where.provider_accountName?.provider === "gemini-cli" &&
          where.provider_accountName.accountName === "teammate@example.com.json"
        ) {
          return { id: "ownership-2", userId: "user-2", accountName: "teammate@example.com.json" };
        }

        return null;
      }
    );
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await bulkUpdateOAuthAccounts("user-1", false, {
      action: "disconnect",
      actionKeys: [
        "oauth:claude:owned%40example.com.json:owned@example.com.json",
        "",
        "oauth:gemini:teammate%40example.com.json:teammate@example.com.json",
      ],
    });

    expect(result).toEqual({
      ok: true,
      summary: { total: 3, successCount: 1, failureCount: 2 },
      failures: [
        { actionKey: "", reason: "Missing action key" },
        {
          actionKey: "oauth:gemini:teammate%40example.com.json:teammate@example.com.json",
          reason: "Access denied",
        },
      ],
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "http://localhost:8317/auth-files?name=owned%40example.com.json&provider=claude",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "ownership-1" } });
  });
});
