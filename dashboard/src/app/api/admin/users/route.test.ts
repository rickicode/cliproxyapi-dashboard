import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn() }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: vi.fn(() => null) }));
vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/auth/password", () => ({ hashPassword: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
  },
}));
vi.mock("@/lib/providers/cascade", () => ({ cascadeDeleteUserProviders: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  AUDIT_ACTION: { USER_CREATED: "USER_CREATED", USER_DELETED: "USER_DELETED" },
  extractIpAddress: vi.fn(() => "127.0.0.1"),
  logAuditAsync: vi.fn(),
}));

describe("POST /api/admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when request JSON is malformed", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    const { hashPassword } = await import("@/lib/auth/password");
    const { prisma } = await import("@/lib/db");
    const { logAuditAsync } = await import("@/lib/audit");

    vi.mocked(verifySession).mockResolvedValue({ userId: "admin-1", username: "admin" } as never);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ isAdmin: true });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: "{",
      })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error?.message).toBe("Invalid JSON body");
    expect(hashPassword).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(logAuditAsync).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects deletion of the final admin without deleting the user", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    const { prisma } = await import("@/lib/db");
    const { cascadeDeleteUserProviders } = await import("@/lib/providers/cascade");

    vi.mocked(verifySession).mockResolvedValue({ userId: "admin-1", username: "admin" } as never);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ isAdmin: true })
      .mockResolvedValueOnce({ id: "admin-2", username: "other-admin", isAdmin: true });
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const { DELETE } = await import("./route");
    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/users?userId=admin-2", {
        method: "DELETE",
        headers: { origin: "http://localhost" },
      })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error?.message).toBe("Cannot delete the last admin account");
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(cascadeDeleteUserProviders).not.toHaveBeenCalled();
  });
});
