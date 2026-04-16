import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const findUniqueMock = vi.fn();
const listOAuthAccountsMock = vi.fn();
const contributeOAuthAccountMock = vi.fn();
const apiSuccessMock = vi.fn((data: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ success: true, ...data }), { status })
);

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: vi.fn(),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));

vi.mock("@/lib/providers/dual-write", () => ({
  contributeOAuthAccount: contributeOAuthAccountMock,
  listOAuthAccounts: listOAuthAccountsMock,
}));

vi.mock("@/lib/errors", () => ({
  ERROR_CODE: {
    PROVIDER_ERROR: "PROVIDER_ERROR",
    PROVIDER_INVALID: "PROVIDER_INVALID",
  },
  Errors: {
    unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    internal: () => new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    validation: (message: string) => new Response(JSON.stringify({ error: message }), { status: 400 }),
    conflict: (message: string) => new Response(JSON.stringify({ error: message }), { status: 409 }),
    rateLimited: () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
  },
  apiError: (_code: string, message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), { status }),
  apiSuccess: apiSuccessMock,
}));

describe("GET /api/providers/oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    findUniqueMock.mockResolvedValue({ isAdmin: false });
  });

  it("returns paginated oauth list metadata", async () => {
    listOAuthAccountsMock.mockResolvedValue({
      ok: true,
      data: {
        items: [{ id: "auth-1", actionKey: "auth-1", status: "active" }],
        page: 2,
        pageSize: 50,
        total: 101,
        totalPages: 3,
        availableStatuses: ["active", "disabled"],
      },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/providers/oauth?q=claude&status=active&page=2&pageSize=50"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        items: [{ id: "auth-1", actionKey: "auth-1", status: "active" }],
        page: 2,
        pageSize: 50,
        total: 101,
        totalPages: 3,
        availableStatuses: ["active", "disabled"],
      },
    });
    expect(apiSuccessMock).toHaveBeenCalledWith({
      data: {
        items: [{ id: "auth-1", actionKey: "auth-1", status: "active" }],
        page: 2,
        pageSize: 50,
        total: 101,
        totalPages: 3,
        availableStatuses: ["active", "disabled"],
      },
    });
    expect(listOAuthAccountsMock).toHaveBeenCalledWith("user-1", false, {
      q: "claude",
      status: "active",
      page: 2,
      pageSize: 50,
      preview: false,
    });
  });

  it("passes preview mode through to the list query", async () => {
    listOAuthAccountsMock.mockResolvedValue({
      ok: true,
      data: {
        items: [],
        page: 1,
        pageSize: 10,
        total: 12,
        totalPages: 1,
        availableStatuses: ["active"],
      },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost/api/providers/oauth?preview=true&page=9&pageSize=100")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      items: [],
      page: 1,
      pageSize: 10,
      total: 12,
      totalPages: 1,
      availableStatuses: ["active"],
    });
    expect(apiSuccessMock).toHaveBeenCalledWith({
      data: {
        items: [],
        page: 1,
        pageSize: 10,
        total: 12,
        totalPages: 1,
        availableStatuses: ["active"],
      },
    });
    expect(listOAuthAccountsMock).toHaveBeenCalledWith("user-1", false, {
      q: "",
      status: "all",
      page: 9,
      pageSize: 100,
      preview: true,
    });
  });
});

describe("POST /api/providers/oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
  });

  it("returns created success when contribute merges with an existing ownership", async () => {
    const { validateOrigin } = await import("@/lib/auth/origin");
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");

    vi.mocked(validateOrigin).mockReturnValue(null);
    vi.mocked(checkRateLimitWithPreset).mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    contributeOAuthAccountMock.mockResolvedValue({
      ok: true,
      id: "ownership-1",
      resolution: "merged_with_existing",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/providers/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          accountName: "claude_user@example.com.json",
          accountEmail: "user@example.com",
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: "ownership-1", resolution: "merged_with_existing" });
  });

  it("returns conflict when contribute reports another user ownership", async () => {
    const { validateOrigin } = await import("@/lib/auth/origin");
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");

    vi.mocked(validateOrigin).mockReturnValue(null);
    vi.mocked(checkRateLimitWithPreset).mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    contributeOAuthAccountMock.mockResolvedValue({
      ok: false,
      error: "OAuth account already registered to another user",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/providers/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          accountName: "claude_user@example.com.json",
          accountEmail: "user@example.com",
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("OAuth account already registered to another user");
  });

  it("returns conflict when contribute reports manual review is required", async () => {
    const { validateOrigin } = await import("@/lib/auth/origin");
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");

    vi.mocked(validateOrigin).mockReturnValue(null);
    vi.mocked(checkRateLimitWithPreset).mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    contributeOAuthAccountMock.mockResolvedValue({
      ok: false,
      error: "OAuth account requires manual review before it can be registered",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/providers/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          accountName: "claude_user@example.com.json",
          accountEmail: "user@example.com",
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("OAuth account requires manual review before it can be registered");
  });

  it("returns validation error for malformed json request bodies", async () => {
    const { validateOrigin } = await import("@/lib/auth/origin");
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");

    vi.mocked(validateOrigin).mockReturnValue(null);
    vi.mocked(checkRateLimitWithPreset).mockReturnValue({ allowed: true, retryAfterSeconds: 0 });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/providers/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"provider":"claude",',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON request body");
    expect(contributeOAuthAccountMock).not.toHaveBeenCalled();
  });

  it("rejects blank or whitespace-only account names", async () => {
    const { validateOrigin } = await import("@/lib/auth/origin");
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");

    vi.mocked(validateOrigin).mockReturnValue(null);
    vi.mocked(checkRateLimitWithPreset).mockReturnValue({ allowed: true, retryAfterSeconds: 0 });

    const { POST } = await import("./route");

    for (const accountName of ["", "   ", "\n\t  "]) {
      const response = await POST(
        new NextRequest("http://localhost/api/providers/oauth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "claude",
            accountName,
            accountEmail: "user@example.com",
          }),
        })
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid request body");
    }

    expect(contributeOAuthAccountMock).not.toHaveBeenCalled();
  });
});
