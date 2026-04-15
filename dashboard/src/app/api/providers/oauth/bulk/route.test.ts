import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const findUniqueMock = vi.fn();
const bulkUpdateOAuthAccountsMock = vi.fn();
const apiSuccessMock = vi.fn((data: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ success: true, ...data }), { status })
);

vi.mock("@/lib/auth/session", () => ({ verifySession: verifySessionMock }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: validateOriginMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));
vi.mock("@/lib/providers/dual-write", () => ({ bulkUpdateOAuthAccounts: bulkUpdateOAuthAccountsMock }));
vi.mock("@/lib/errors", () => ({
  Errors: {
    unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    validation: (message: string) => new Response(JSON.stringify({ error: message }), { status: 400 }),
    internal: () => new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
  },
  apiSuccess: apiSuccessMock,
}));

describe("POST /api/providers/oauth/bulk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "admin-1" });
    validateOriginMock.mockReturnValue(null);
    findUniqueMock.mockResolvedValue({ isAdmin: true });
  });

  it("returns partial-success summaries for mixed selections", async () => {
    bulkUpdateOAuthAccountsMock.mockResolvedValue({
      ok: true,
      summary: { total: 2, successCount: 1, failureCount: 1 },
      failures: [{ actionKey: "auth-2", reason: "Access denied" }],
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", actionKeys: ["auth-1", "auth-2"] }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(207);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      select: { isAdmin: true },
    });
    expect(bulkUpdateOAuthAccountsMock).toHaveBeenCalledWith("admin-1", true, {
      action: "disable",
      actionKeys: ["auth-1", "auth-2"],
    });
    expect(body).toEqual({
      success: true,
      data: {
        summary: { total: 2, successCount: 1, failureCount: 1 },
        failures: [{ actionKey: "auth-2", reason: "Access denied" }],
      },
    });
    expect(apiSuccessMock).toHaveBeenCalledWith(
      {
        data: {
          summary: { total: 2, successCount: 1, failureCount: 1 },
          failures: [{ actionKey: "auth-2", reason: "Access denied" }],
        },
      },
      207
    );
  });

  it("returns 200 with nested data when all selected actions succeed", async () => {
    bulkUpdateOAuthAccountsMock.mockResolvedValue({
      ok: true,
      summary: { total: 2, successCount: 2, failureCount: 0 },
      failures: [],
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enable", actionKeys: ["auth-1", "auth-2"] }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        summary: { total: 2, successCount: 2, failureCount: 0 },
        failures: [],
      },
    });
    expect(apiSuccessMock).toHaveBeenCalledWith(
      {
        data: {
          summary: { total: 2, successCount: 2, failureCount: 0 },
          failures: [],
        },
      },
      200
    );
  });

  it("rejects invalid request bodies", async () => {
    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", actionKeys: ["auth-1", 42] }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(bulkUpdateOAuthAccountsMock).not.toHaveBeenCalled();
    expect(body.error).toBe("Invalid request body");
  });
});
