import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  verifySessionMock,
  validateOriginMock,
  checkRateLimitWithPresetMock,
  findUniqueMock,
  fetchWithTimeoutMock,
  resolveOAuthOwnershipMock,
} = vi.hoisted(() => ({
  verifySessionMock: vi.fn(),
  validateOriginMock: vi.fn(),
  checkRateLimitWithPresetMock: vi.fn(),
  findUniqueMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  resolveOAuthOwnershipMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: checkRateLimitWithPresetMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/providers/management-api", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
  MANAGEMENT_BASE_URL: "http://cliproxyapi:8317/v0/management",
  MANAGEMENT_API_KEY: "test-key",
  isRecord: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
}));

vi.mock("@/lib/providers/oauth-ownership-resolver", () => ({
  resolveOAuthOwnership: resolveOAuthOwnershipMock,
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function postClaim(body: Record<string, unknown>) {
  const { POST } = await import("./route");

  const request = new NextRequest("http://localhost/api/providers/oauth/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });

  return POST(request);
}

describe("POST /api/providers/oauth/claim", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    verifySessionMock.mockResolvedValue({ userId: "admin-user" });
    validateOriginMock.mockReturnValue(null);
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true });
    findUniqueMock.mockResolvedValue({ isAdmin: true });
  });

  it("returns created when the resolver claims an unowned account", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            provider: "claude",
            email: "user@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-1",
        userId: "admin-user",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "ownership-1",
      accountName: "claude-user@example.com.json",
      provider: "claude",
    });
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "admin-user",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "user@example.com",
    });
  });

  it("returns success when the resolver merges an existing ownership for the current admin", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            provider: "claude",
            email: "user@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-2",
        userId: "admin-user",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "ownership-2",
      accountName: "claude-user@example.com.json",
      provider: "claude",
    });
  });

  it("returns conflict when the resolver reports another owner", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            provider: "claude",
            email: "user@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed_by_other_user",
      ownership: {
        id: "ownership-3",
        userId: "user-2",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "RESOURCE_ALREADY_EXISTS",
        message: "Account already has an owner",
      },
    });
  });

  it("ignores same-name entries without provider metadata when a provider-scoped match exists", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            email: "user@example.com",
          },
          {
            name: "claude-user@example.com.json",
            provider: "claude",
            email: "user@example.com",
          },
        ],
      })
    );

    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-1",
        userId: "admin-user",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "ownership-1",
      accountName: "claude-user@example.com.json",
      provider: "claude",
    });
  });

  it("ignores malformed same-name entries from other providers when a provider-scoped match exists", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            provider: 42,
            type: null,
            email: ["user@example.com"],
          },
          {
            name: "claude-user@example.com.json",
            provider: "claude",
            email: "user@example.com",
          },
        ],
      })
    );

    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-1",
        userId: "admin-user",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "ownership-1",
      accountName: "claude-user@example.com.json",
      provider: "claude",
    });
  });

  it("returns bad gateway when management API returns invalid JSON", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response("not-json", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "Upstream service error",
      },
    });
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("returns bad gateway when management API returns malformed shape", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: {
          name: "claude-user@example.com.json",
          provider: "claude",
        },
      })
    );

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "Upstream service error",
      },
    });
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("requires provider in the request body", async () => {
    const response = await postClaim({ accountName: "claude-user@example.com.json" });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body must include 'accountName' and 'provider' (string)",
      },
    });
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("matches auth files by provider plus account name when duplicate account names exist across providers", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "shared@example.com.json",
            provider: "codex",
            email: "wrong@example.com",
          },
          {
            name: "shared@example.com.json",
            provider: "claude",
            email: "right@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-4",
        userId: "admin-user",
        provider: "claude",
        accountName: "shared@example.com.json",
        accountEmail: "right@example.com",
      },
    });

    const response = await postClaim({ accountName: "shared@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "ownership-4",
      accountName: "shared@example.com.json",
      provider: "claude",
    });
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "admin-user",
      provider: "claude",
      accountName: "shared@example.com.json",
      accountEmail: "right@example.com",
    });
  });

  it("accepts provider aliases when matching the management auth file", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "shared@example.com.json",
            provider: "claude",
            email: "right@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-5",
        userId: "admin-user",
        provider: "claude",
        accountName: "shared@example.com.json",
        accountEmail: "right@example.com",
      },
    });

    const response = await postClaim({ accountName: "shared@example.com.json", provider: "anthropic" });

    expect(response.status).toBe(201);
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "admin-user",
      provider: "claude",
      accountName: "shared@example.com.json",
      accountEmail: "right@example.com",
    });
  });

  it("uses inferred provider matching when auth-file metadata is missing", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-inferred-user@example.com.json",
            email: "user@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-6",
        userId: "admin-user",
        provider: "claude",
        accountName: "claude-inferred-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-inferred-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "ownership-6",
      accountName: "claude-inferred-user@example.com.json",
      provider: "claude",
    });
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "admin-user",
      provider: "claude",
      accountName: "claude-inferred-user@example.com.json",
      accountEmail: "user@example.com",
    });
  });

  it("prefers explicit provider metadata over inferred same-name matches", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            email: "inferred@example.com",
          },
          {
            name: "claude-user@example.com.json",
            provider: "claude",
            email: "explicit@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-7",
        userId: "admin-user",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "explicit@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "ownership-7",
      accountName: "claude-user@example.com.json",
      provider: "claude",
    });
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "admin-user",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "explicit@example.com",
    });
  });

  it("ignores non-meaningful provider metadata and falls back to identifier inference for claim matching", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            provider: "unknown",
            email: "user@example.com",
          },
        ],
      })
    );
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-8",
        userId: "admin-user",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postClaim({ accountName: "claude-user@example.com.json", provider: "claude" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "ownership-8",
      accountName: "claude-user@example.com.json",
      provider: "claude",
    });
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "admin-user",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "user@example.com",
    });
  });
});
