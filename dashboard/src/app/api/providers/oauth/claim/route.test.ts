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

    const response = await postClaim({ accountName: "claude-user@example.com.json" });
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

    const response = await postClaim({ accountName: "claude-user@example.com.json" });
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

    const response = await postClaim({ accountName: "claude-user@example.com.json" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "RESOURCE_ALREADY_EXISTS",
        message: "Account already has an owner",
      },
    });
  });

  it("returns bad gateway when auth file metadata lacks provider and type", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            email: "user@example.com",
          },
        ],
      })
    );

    const response = await postClaim({ accountName: "claude-user@example.com.json" });
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

  it("returns bad gateway when the matched auth file has malformed fields", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: "claude-user@example.com.json",
            provider: 42,
            type: null,
            email: ["user@example.com"],
          },
        ],
      })
    );

    const response = await postClaim({ accountName: "claude-user@example.com.json" });
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

  it("returns bad gateway when management API returns invalid JSON", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response("not-json", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    const response = await postClaim({ accountName: "claude-user@example.com.json" });
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

    const response = await postClaim({ accountName: "claude-user@example.com.json" });
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
});
