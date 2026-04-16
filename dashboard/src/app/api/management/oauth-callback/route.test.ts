import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  verifySessionMock,
  validateOriginMock,
  checkRateLimitWithPresetMock,
  findManyMock,
  createMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifySessionMock: vi.fn(),
  validateOriginMock: vi.fn(),
  checkRateLimitWithPresetMock: vi.fn(),
  findManyMock: vi.fn(),
  createMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));

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
    providerOAuthOwnership: {
      findMany: findManyMock,
      create: createMock,
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

vi.mock("@/generated/prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;

      constructor(code = "P2002") {
        super("Prisma error");
        this.code = code;
      }
    },
  },
}));

vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function postOAuthCallback(body: Record<string, unknown>) {
  const { POST } = await import("./route");

  const request = new NextRequest("http://localhost/api/management/oauth-callback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });

  const responsePromise = POST(request);
  await vi.runAllTimersAsync();
  return responsePromise;
}

describe("POST /api/management/oauth-callback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("MANAGEMENT_API_KEY", "test-key");
    vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://cliproxyapi:8317/v0/management");

    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true });
    createMock.mockResolvedValue({ id: "ownership-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns connect success with a normalized claimed autoClaim result", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(
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
    findManyMock.mockResolvedValueOnce([]);

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-1",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "claimed",
        candidate: {
          accountName: "claude-user@example.com.json",
          accountEmail: "user@example.com",
          ownerUserId: "user-1",
          ownerUsername: null,
        },
      },
    });
    expect(createMock).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
  });

  it("returns connect success with no_match when no candidate can be classified", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ files: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
    for (let index = 0; index < 10; index += 1) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ files: [] }));
    }
    findManyMock.mockResolvedValue([]);

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-2",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "no_match",
      },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns connect success with ambiguous when multiple candidates match", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            { name: "claude-a@example.com.json", provider: "claude", email: "a@example.com" },
            { name: "claude-b@example.com.json", provider: "claude", email: "b@example.com" },
          ],
        })
      );
    findManyMock.mockResolvedValueOnce([]);

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-3",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "ambiguous",
        candidates: [
          {
            accountName: "claude-a@example.com.json",
            accountEmail: "a@example.com",
            ownerUserId: null,
            ownerUsername: null,
          },
          {
            accountName: "claude-b@example.com.json",
            accountEmail: "b@example.com",
            ownerUserId: null,
            ownerUsername: null,
          },
        ],
      },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns connect success with already_owned_by_current_user when the candidate is already owned", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(
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
    findManyMock.mockResolvedValueOnce([
      {
        accountName: "claude-user@example.com.json",
        userId: "user-1",
        user: { id: "user-1", username: "ricki" },
      },
    ]);

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-4",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "already_owned_by_current_user",
        candidate: {
          accountName: "claude-user@example.com.json",
          accountEmail: "user@example.com",
          ownerUserId: "user-1",
          ownerUsername: "ricki",
        },
      },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns connect success with claimed_by_other_user when the candidate is owned by another user", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(
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
    findManyMock.mockResolvedValueOnce([
      {
        accountName: "claude-user@example.com.json",
        userId: "user-2",
        user: { id: "user-2", username: "teammate" },
      },
    ]);

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-5",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "claimed_by_other_user",
        candidate: {
          accountName: "claude-user@example.com.json",
          accountEmail: "user@example.com",
          ownerUserId: "user-2",
          ownerUsername: "teammate",
        },
      },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns connect success with autoClaim error when ownership lookup fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(
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
    findManyMock.mockRejectedValueOnce(new Error("lookup failed"));

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-6",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "error",
        failure: {
          code: "ownership_lookup_failed",
          message: "Failed to evaluate OAuth auto-claim candidates",
        },
      },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns ambiguous for non-callback providers when multiple unclaimed files exist and newness cannot be inferred safely", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            { name: "cursor-old.json", provider: "cursor", email: "old@example.com" },
            { name: "cursor-new.json", provider: "cursor", email: "new@example.com" },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            { name: "cursor-old.json", provider: "cursor", email: "old@example.com" },
            { name: "cursor-new.json", provider: "cursor", email: "new@example.com" },
          ],
        })
      );
    findManyMock.mockResolvedValue([]);

    const response = await postOAuthCallback({
      provider: "cursor",
      state: "state-cursor-1",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "ambiguous",
        candidates: [
          {
            accountName: "cursor-old.json",
            accountEmail: "old@example.com",
            ownerUserId: null,
            ownerUsername: null,
          },
          {
            accountName: "cursor-new.json",
            accountEmail: "new@example.com",
            ownerUserId: null,
            ownerUsername: null,
          },
        ],
      },
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});
