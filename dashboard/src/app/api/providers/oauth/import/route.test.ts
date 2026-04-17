import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

async function useRealValidateOrigin() {
  const actual = await vi.importActual<typeof import("@/lib/auth/origin")>("@/lib/auth/origin");
  validateOriginMock.mockImplementation(actual.validateOrigin);
}

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const checkRateLimitWithPresetMock = vi.fn();
const importOAuthCredentialMock = vi.fn();
const importBulkCodexOAuthCredentialsMock = vi.fn();
const logAuditAsyncMock = vi.fn();
const extractIpAddressMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: checkRateLimitWithPresetMock,
}));

vi.mock("@/lib/providers/dual-write", () => ({
  importOAuthCredential: importOAuthCredentialMock,
  importBulkCodexOAuthCredentials: importBulkCodexOAuthCredentialsMock,
}));

vi.mock("@/lib/errors", () => ({
  ERROR_CODE: {
    PROVIDER_INVALID: "PROVIDER_INVALID",
    RESOURCE_ALREADY_EXISTS: "RESOURCE_ALREADY_EXISTS",
    PROVIDER_ERROR: "PROVIDER_ERROR",
  },
  Errors: {
    unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    validation: (message: string) => new Response(JSON.stringify({ error: message }), { status: 400 }),
    zodValidation: (issues: unknown) => new Response(JSON.stringify({ error: "validation", issues }), { status: 400 }),
    rateLimited: () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
    internal: (message: string) => new Response(JSON.stringify({ error: message }), { status: 500 }),
  },
  apiError: (_code: string, message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), { status }),
}));

vi.mock("@/lib/audit", () => ({
  AUDIT_ACTION: {
    OAUTH_CREDENTIAL_IMPORTED: "oauth_credential_imported",
  },
  logAuditAsync: logAuditAsyncMock,
  extractIpAddress: extractIpAddressMock,
}));

describe("POST /api/providers/oauth/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true });
    extractIpAddressMock.mockReturnValue("127.0.0.1");
  });

  it("returns 403 when Origin header is omitted", async () => {
    await useRealValidateOrigin();

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        fileName: "codex_user@example.com.json",
        fileContent: JSON.stringify({
          type: "codex",
          email: "user@example.com",
          access_token: "token",
        }),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Forbidden");
    expect(checkRateLimitWithPresetMock).not.toHaveBeenCalled();
    expect(importOAuthCredentialMock).not.toHaveBeenCalled();
  });

  it("returns 403 for spoofed forwarded headers when request URL origin does not match", async () => {
    await useRealValidateOrigin();

    const { POST } = await import("./route");
    const request = new NextRequest("https://internal.example.net/api/providers/oauth/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "https://dashboard.example.com",
        "x-forwarded-host": "dashboard.example.com",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        provider: "codex",
        fileName: "codex_user@example.com.json",
        fileContent: JSON.stringify({
          type: "codex",
          email: "user@example.com",
          access_token: "token",
        }),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Forbidden");
    expect(checkRateLimitWithPresetMock).not.toHaveBeenCalled();
    expect(importOAuthCredentialMock).not.toHaveBeenCalled();
  });

  it("accepts a codex bulk payload and returns per-item results", async () => {
    importBulkCodexOAuthCredentialsMock.mockResolvedValue({
      results: [
        {
          email: "user@example.com",
          ok: true,
          accountName: "codex_user@example.com.json",
        },
      ],
      summary: {
        total: 1,
        successCount: 1,
        failureCount: 0,
      },
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        bulkCredentials: [
          {
            email: "user@example.com",
            access_token: "token",
            refresh_token: "refresh",
          },
        ],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(207);
    expect(importBulkCodexOAuthCredentialsMock).toHaveBeenCalledWith("user-1", [
      {
        email: "user@example.com",
        access_token: "token",
        refresh_token: "refresh",
      },
    ]);
    expect(body.data.summary).toEqual({
      total: 1,
      successCount: 1,
      failureCount: 0,
    });
  });

  it("rejects bulk payloads for non-codex providers", async () => {
    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        bulkCredentials: [
          {
            email: "user@example.com",
            access_token: "token",
          },
        ],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(importBulkCodexOAuthCredentialsMock).not.toHaveBeenCalled();
    expect(body.error).toBeDefined();
  });

  it("rejects bulk codex items whose email is blank after trimming", async () => {
    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        bulkCredentials: [
          {
            email: "   ",
            access_token: "token",
          },
        ],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(importBulkCodexOAuthCredentialsMock).not.toHaveBeenCalled();
    expect(body.error).toBe("validation");
  });

  it("rejects duplicate emails within a single codex bulk payload", async () => {
    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        bulkCredentials: [
          {
            email: "user@example.com",
            access_token: "token-1",
          },
          {
            email: " user@example.com ",
            access_token: "token-2",
          },
        ],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(importBulkCodexOAuthCredentialsMock).not.toHaveBeenCalled();
    expect(body.error).toBe("validation");
  });

  it("returns created success when import merges into an existing ownership", async () => {
    importOAuthCredentialMock.mockResolvedValue({
      ok: true,
      id: "ownership-1",
      accountName: "codex_user@example.com_v2.json",
      resolution: "merged_with_existing",
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        fileName: "codex_user@example.com.json",
        fileContent: JSON.stringify({
          type: "codex",
          email: "user@example.com",
          access_token: "token",
        }),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data).toEqual({
      id: "ownership-1",
      accountName: "codex_user@example.com_v2.json",
      resolution: "merged_with_existing",
    });
  });

  it("returns conflict when import needs manual review", async () => {
    importOAuthCredentialMock.mockResolvedValue({
      ok: false,
      error: "Credential import requires manual review before ownership can be assigned",
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        fileName: "codex_user@example.com.json",
        fileContent: JSON.stringify({
          type: "codex",
          email: "user@example.com",
          access_token: "token",
        }),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("Credential import requires manual review before ownership can be assigned");
  });

  it("returns conflict when import reports another user already claimed the credential", async () => {
    importOAuthCredentialMock.mockResolvedValue({
      ok: false,
      error: "Credential already imported and claimed by another user",
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        fileName: "codex_user@example.com.json",
        fileContent: JSON.stringify({
          type: "codex",
          email: "user@example.com",
          access_token: "token",
        }),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("Credential already imported and claimed by another user");
  });

  it("returns conflict when import reports ambiguous ownership", async () => {
    importOAuthCredentialMock.mockResolvedValue({
      ok: false,
      error: "Credential import is ambiguous and requires manual review before ownership can be assigned",
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        fileName: "codex_user@example.com.json",
        fileContent: JSON.stringify({
          type: "codex",
          email: "user@example.com",
          access_token: "token",
        }),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe(
      "Credential import is ambiguous and requires manual review before ownership can be assigned"
    );
  });

  it("returns conflict when import reports post-upload manual review failure", async () => {
    importOAuthCredentialMock.mockResolvedValue({
      ok: false,
      error: "Credential upload succeeded but ownership could not be verified; manual review required",
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        fileName: "codex_user@example.com.json",
        fileContent: JSON.stringify({
          type: "codex",
          email: "user@example.com",
          access_token: "token",
        }),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe(
      "Credential upload succeeded but ownership could not be verified; manual review required"
    );
  });

  it("returns validation 400 for malformed top-level request JSON", async () => {
    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(importOAuthCredentialMock).not.toHaveBeenCalled();
    expect(importBulkCodexOAuthCredentialsMock).not.toHaveBeenCalled();
    expect(body.error).toBe("Invalid JSON request body");
  });
});
