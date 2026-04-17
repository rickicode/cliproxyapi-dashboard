import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { resolveOAuthOwnershipMock } = vi.hoisted(() => ({
  resolveOAuthOwnershipMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("@/lib/providers/oauth-ownership-resolver", () => ({
  resolveOAuthOwnership: resolveOAuthOwnershipMock,
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

import {
  buildCodexBulkImportFileContent,
  buildCodexBulkImportFileName,
  contributeOAuthAccount,
  importOAuthCredential,
} from "@/lib/providers/oauth-ops";
import { fetchWithTimeout } from "@/lib/providers/management-api";

describe("buildCodexBulkImportFileName", () => {
  it("builds a codex-prefixed file name from email", () => {
    expect(buildCodexBulkImportFileName("user@example.com")).toBe("codex_user@example.com.json");
  });

  it("sanitizes unsafe file-name characters", () => {
    expect(buildCodexBulkImportFileName("user/name+tag@example.com")).toBe("codex_user%2Fname+tag@example.com.json");
  });

  it("does not collide for distinct valid email addresses", () => {
    const plusAddress = buildCodexBulkImportFileName("user+tag@example.com");
    const underscoreAddress = buildCodexBulkImportFileName("user_tag@example.com");

    expect(plusAddress).not.toBe(underscoreAddress);
  });
});

describe("buildCodexBulkImportFileContent", () => {
  it("adds the codex type and preserves email for CLIProxyAPI auth-file detection", () => {
    expect(
      JSON.parse(
        buildCodexBulkImportFileContent({
          email: "user@example.com",
          access_token: "token",
          refresh_token: "refresh",
        })
      )
    ).toEqual({
      type: "codex",
      email: "user@example.com",
      access_token: "token",
      refresh_token: "refresh",
    });
  });
});

describe("contributeOAuthAccount", () => {
  it("returns success when the resolver merges a safe duplicate for the current user", async () => {
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-merge-1",
        userId: "user-1",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    await expect(
      contributeOAuthAccount(
        "user-1",
        "claude",
        "claude_user@example.com.json",
        "user@example.com"
      )
    ).resolves.toEqual({
      ok: true,
      id: "ownership-merge-1",
      resolution: "merged_with_existing",
    });
  });

  it("returns conflict when the resolver reports another user owns the account", async () => {
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed_by_other_user",
      ownership: {
        id: "ownership-other-1",
        userId: "user-2",
        provider: "claude",
        accountName: "claude_user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    await expect(
      contributeOAuthAccount(
        "user-1",
        "claude",
        "claude_user@example.com.json",
        "user@example.com"
      )
    ).resolves.toEqual({
      ok: false,
      error: "OAuth account already registered to another user",
    });
  });
});

describe("importOAuthCredential", () => {
  beforeEach(() => {
    resolveOAuthOwnershipMock.mockReset();
    vi.mocked(fetchWithTimeout).mockReset();

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success with merged ownership when imported auth safely matches an existing account", async () => {
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-import-1",
        userId: "user-1",
        provider: "codex",
        accountName: "codex_user@example.com_v2.json",
        accountEmail: "user@example.com",
      },
    });

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [{ name: "existing-file.json" }] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              { name: "existing-file.json", provider: "codex" },
              {
                name: "codex_user@example.com_v2.json",
                provider: "codex",
                email: "user@example.com",
              },
            ],
          }),
          { status: 200 }
        )
      );

    await expect(
      importOAuthCredential(
        "user-1",
        "codex",
        "codex_user@example.com.json",
        JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
      )
    ).resolves.toEqual({
      ok: true,
      id: "ownership-import-1",
      accountName: "codex_user@example.com_v2.json",
      resolution: "merged_with_existing",
    });
  });

  it("falls back to the single provider-matching new file when the pre-upload snapshot succeeded but was empty", async () => {
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-import-empty-snapshot-1",
        userId: "user-1",
        provider: "codex",
        accountName: "managed-upload-123.json",
        accountEmail: "user@example.com",
      },
    });

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                name: "managed-upload-123.json",
                provider: "codex",
                email: "user@example.com",
              },
            ],
          }),
          { status: 200 }
        )
      );

    await expect(
      importOAuthCredential(
        "user-1",
        "codex",
        "codex_user@example.com.json",
        JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
      )
    ).resolves.toEqual({
      ok: true,
      id: "ownership-import-empty-snapshot-1",
      accountName: "managed-upload-123.json",
      resolution: "merged_with_existing",
    });
  });

  it("does not use provider-only fallback when polling response contains malformed auth-file entries", async () => {
    const malformedPollResponse = new Response(
      JSON.stringify({
        files: [
          {
            name: "codex_user@example.com_v2.json",
            provider: { nested: "value" },
            email: ["bad@example.com"],
          },
          {
            name: "managed-upload-123.json",
            provider: "codex",
            email: "other@example.com",
          },
        ],
      }),
      { status: 200 }
    );

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [{ name: "existing-file.json" }] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(malformedPollResponse)
      .mockImplementation(() => Promise.resolve(malformedPollResponse.clone()));

    await expect(
      importOAuthCredential(
        "user-1",
        "codex",
        "codex_user@example.com.json",
        JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
      )
    ).resolves.toEqual({
      ok: false,
      error: "Credential upload succeeded but ownership could not be verified; manual review required",
    });

    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("does not use provider-only fallback when the pre-upload snapshot response is malformed", async () => {
    resolveOAuthOwnershipMock.mockClear();

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockImplementation(() => Promise.resolve(
        new Response(
          JSON.stringify({
            files: [
              {
                name: "managed-upload-123.json",
                provider: "codex",
                email: "user@example.com",
              },
            ],
          }),
          { status: 200 }
        )
      ));

    await expect(
      importOAuthCredential(
        "user-1",
        "codex",
        "codex_user@example.com.json",
        JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
      )
    ).resolves.toEqual({
      ok: false,
      error: "Credential upload succeeded but ownership could not be verified; manual review required",
    });

    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("returns manual review style failure when ownership resolution is ambiguous", async () => {
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "ambiguous",
      ownerships: [
        {
          id: "ownership-a",
          userId: "user-1",
          provider: "codex",
          accountName: "codex_user@example.com.json",
          accountEmail: "user@example.com",
        },
        {
          id: "ownership-b",
          userId: "user-1",
          provider: "codex",
          accountName: "codex_user+other@example.com.json",
          accountEmail: "user@example.com",
        },
      ],
    });

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [{ name: "codex_user@example.com.json", provider: "codex", email: "user@example.com" }],
          }),
          { status: 200 }
        )
      );

    await expect(
      importOAuthCredential(
        "user-1",
        "codex",
        "codex_user@example.com.json",
        JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
      )
    ).resolves.toEqual({
      ok: false,
      error: "Credential import requires manual review before ownership can be assigned",
    });
  });

  it("fails conservatively when multiple fuzzy basename matches exist", async () => {
    resolveOAuthOwnershipMock.mockClear();

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockImplementation(() => Promise.resolve(
        new Response(
          JSON.stringify({
            files: [
              {
                name: "codex_user@example.com_backup.json",
                provider: "codex",
                email: "user@example.com",
              },
              {
                name: "codex_user@example.com_v2.json",
                provider: "codex",
                email: "user@example.com",
              },
            ],
          }),
          { status: 200 }
        )
      ));

    await expect(
      importOAuthCredential(
        "user-1",
        "codex",
        "codex_user@example.com.json",
        JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
      )
    ).resolves.toEqual({
      ok: false,
      error: "Credential upload succeeded but ownership could not be verified; manual review required",
    });

    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("fails conservatively when upload cannot be matched to a claimable auth file", async () => {
    resolveOAuthOwnershipMock.mockClear();

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockImplementation(() => Promise.resolve(
        new Response(
          JSON.stringify({
            files: [{ name: "different-file.json", provider: "claude", email: "other@example.com" }],
          }),
          { status: 200 }
        )
      ));

    await expect(
      importOAuthCredential(
        "user-1",
        "codex",
        "codex_user@example.com.json",
        JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
      )
    ).resolves.toEqual({
      ok: false,
      error: "Credential upload succeeded but ownership could not be verified; manual review required",
    });

    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it.each([
    ["error", { kind: "error", failure: { message: "ownership lookup failed" } }],
    [
      "claimed_by_other_user",
      {
        kind: "claimed_by_other_user",
        ownership: {
          id: "ownership-other-1",
          userId: "user-2",
          provider: "codex",
          accountName: "codex_user@example.com.json",
          accountEmail: "user@example.com",
        },
      },
    ],
    [
      "ambiguous",
      {
        kind: "ambiguous",
        ownerships: [
          {
            id: "ownership-a",
            userId: "user-1",
            provider: "codex",
            accountName: "codex_user@example.com.json",
            accountEmail: "user@example.com",
          },
          {
            id: "ownership-b",
            userId: "user-1",
            provider: "codex",
            accountName: "codex_user+other@example.com.json",
            accountEmail: "user@example.com",
          },
        ],
      },
    ],
  ])("cleans up uploaded auth file when post-upload ownership resolves as %s", async (_kind, resolution) => {
    resolveOAuthOwnershipMock.mockResolvedValueOnce(resolution);

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [{ name: "codex_user@example.com.json", provider: "codex", email: "user@example.com" }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await importOAuthCredential(
      "user-1",
      "codex",
      "codex_user@example.com.json",
      JSON.stringify({ type: "codex", email: "user@example.com", access_token: "token" })
    );

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      "http://localhost:8317/auth-files?name=codex_user%40example.com.json",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer test-key" },
      }
    );
  });
});
