import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/env", () => ({
  env: {
    CLIPROXYAPI_MANAGEMENT_URL: "http://localhost:8317",
    MANAGEMENT_API_KEY: "test-api-key",
  },
}));

import { syncOAuthAccountStatus } from "@/lib/providers/management-api";

const MOCK_MANAGEMENT_BASE_URL = "http://localhost:8317";
const MOCK_MANAGEMENT_API_KEY = "test-api-key";

describe("syncOAuthAccountStatus", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("posts auth-file status updates and returns ok on success", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      syncOAuthAccountStatus({
        accountName: "claude_user@example.com.json",
        provider: "claude",
        status: "revoked",
        statusMessage: "Refresh token expired",
        unavailable: true,
      })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${MOCK_MANAGEMENT_BASE_URL}/auth-files/status`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": MOCK_MANAGEMENT_API_KEY,
        },
        body: JSON.stringify({
          name: "claude_user@example.com.json",
          provider: "claude",
          status: "revoked",
          status_message: "Refresh token expired",
          unavailable: true,
        }),
      })
    );
  });

  it("returns an error result when upstream responds with a non-ok status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream failure", { status: 500 }));

    await expect(
      syncOAuthAccountStatus({
        accountName: "claude_user@example.com.json",
        provider: "claude",
        status: "revoked",
        statusMessage: "Refresh token expired",
        unavailable: true,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("HTTP 500"),
    });
  });

  it("returns an error result when the management API request rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(
      syncOAuthAccountStatus({
        accountName: "claude_user@example.com.json",
        provider: "claude",
        status: "revoked",
        statusMessage: "Refresh token expired",
        unavailable: true,
      })
    ).resolves.toEqual({
      ok: false,
      error: "Management API auth-file status sync failed: socket hang up",
    });
  });
});
