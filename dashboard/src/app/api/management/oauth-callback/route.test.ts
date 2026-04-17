import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  verifySessionMock,
  validateOriginMock,
  checkRateLimitWithPresetMock,
  findManyMock,
  resolveOAuthOwnershipMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifySessionMock: vi.fn(),
  validateOriginMock: vi.fn(),
  checkRateLimitWithPresetMock: vi.fn(),
  findManyMock: vi.fn(),
  resolveOAuthOwnershipMock: vi.fn(),
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
    },
  },
}));

vi.mock("@/lib/providers/oauth-ownership-resolver", () => ({
  resolveOAuthOwnership: resolveOAuthOwnershipMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
    fetchMock.mockReset();
    findManyMock.mockReset();
    resolveOAuthOwnershipMock.mockReset();
    verifySessionMock.mockReset();
    validateOriginMock.mockReset();
    checkRateLimitWithPresetMock.mockReset();
    vi.useFakeTimers();
    vi.stubEnv("MANAGEMENT_API_KEY", "test-key");
    vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://cliproxyapi:8317/v0/management");

    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true });
    resolveOAuthOwnershipMock.mockResolvedValue({
      kind: "claimed",
      ownership: {
        id: "ownership-1",
        userId: "user-1",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("routes callback auto-claim through the shared resolver for claimed outcomes", async () => {
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
      state: "state-1",
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
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "user-1",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "user@example.com",
    });
  });

  it("does not use heuristic fallback when callback discovery response contains malformed auth-file entries", async () => {
    const malformedDiscoveryResponse = jsonResponse({
      files: [
        {
          name: "claude-state-malformed.json",
          provider: { nested: "value" },
          email: ["bad@example.com"],
        },
        {
          name: "claude-other-user@example.com.json",
          provider: "claude",
          email: "other@example.com",
        },
      ],
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(malformedDiscoveryResponse)
      .mockImplementation(() => Promise.resolve(malformedDiscoveryResponse.clone()));
    findManyMock.mockResolvedValueOnce([]);

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-malformed-1",
      state: "state-malformed-1",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "no_match",
      },
    });
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("returns merged_with_existing when the resolver merges the callback result into an existing ownership", async () => {
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
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "merged_with_existing",
      ownership: {
        id: "ownership-1",
        userId: "user-1",
        provider: "claude",
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-merge",
      state: "state-merge",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "merged_with_existing",
        candidate: {
          accountName: "claude-user@example.com.json",
          accountEmail: "user@example.com",
          ownerUserId: "user-1",
          ownerUsername: null,
        },
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
      state: "state-2",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "no_match",
      },
    });
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
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
      state: "state-3",
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
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("returns ambiguous for callback providers when multiple unclaimed candidates remain and no safe newness inference exists", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            { name: "claude-existing-a.json", provider: "claude", email: "a@example.com" },
            { name: "claude-existing-b.json", provider: "claude", email: "b@example.com" },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({}, 200));

    for (let index = 0; index < 10; index += 1) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          files: [
            { name: "claude-existing-a.json", provider: "claude", email: "a@example.com" },
            { name: "claude-existing-b.json", provider: "claude", email: "b@example.com" },
          ],
        })
      );
    }

    findManyMock.mockResolvedValue([]);

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-ambiguous-fallback",
      state: "state-ambiguous-fallback",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "ambiguous",
        candidates: [
          {
            accountName: "claude-existing-a.json",
            accountEmail: "a@example.com",
            ownerUserId: null,
            ownerUsername: null,
          },
          {
            accountName: "claude-existing-b.json",
            accountEmail: "b@example.com",
            ownerUserId: null,
            ownerUsername: null,
          },
        ],
      },
    });
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("rejects callback submissions when the provided request state does not match the callback URL state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const response = await postOAuthCallback({
      provider: "claude",
      callbackUrl: "http://localhost/callback?code=abc&state=state-from-url",
      state: "state-from-client",
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Callback state does not match the active OAuth flow",
      },
    });
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
      state: "state-4",
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
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
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
      state: "state-5",
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
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
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
      state: "state-6",
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
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });

  it("routes non-callback auto-claim through the shared resolver when a single unclaimed candidate is found", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            { name: "cursor-user.json", provider: "cursor", email: "user@example.com" },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            { name: "cursor-user.json", provider: "cursor", email: "user@example.com" },
          ],
        })
      );
    findManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    resolveOAuthOwnershipMock.mockResolvedValueOnce({
      kind: "claimed",
      ownership: {
        id: "ownership-cursor-1",
        userId: "user-1",
        provider: "cursor",
        accountName: "cursor-user.json",
        accountEmail: "user@example.com",
      },
    });

    const response = await postOAuthCallback({
      provider: "cursor",
      state: "state-cursor-claim",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 200,
      autoClaim: {
        kind: "claimed",
        candidate: {
          accountName: "cursor-user.json",
          accountEmail: "user@example.com",
          ownerUserId: "user-1",
          ownerUsername: null,
        },
      },
    });
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "user-1",
      provider: "cursor",
      accountName: "cursor-user.json",
      accountEmail: "user@example.com",
    });
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
    expect(resolveOAuthOwnershipMock).not.toHaveBeenCalled();
  });
});
