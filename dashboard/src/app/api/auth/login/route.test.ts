import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const getUserByUsernameMock = vi.fn();
const verifyPasswordMock = vi.fn();
const signTokenMock = vi.fn();
const createSessionMock = vi.fn();
const checkRateLimitMock = vi.fn();
const logAuditAsyncMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock("@/lib/auth/dal", () => ({
  getUserByUsername: getUserByUsernameMock,
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: verifyPasswordMock,
}));

vi.mock("@/lib/auth/jwt", () => ({
  signToken: signTokenMock,
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: createSessionMock,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/audit", () => ({
  AUDIT_ACTION: {
    USER_LOGIN: "USER_LOGIN",
  },
  logAuditAsync: logAuditAsyncMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
  },
}));

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockReturnValue({ allowed: true });
    getUserByUsernameMock.mockResolvedValue({
      id: "user-1",
      username: "admin",
      passwordHash: "stored-hash",
      sessionVersion: 1,
    });
    verifyPasswordMock.mockResolvedValue(true);
    signTokenMock.mockResolvedValue("signed-token");
    createSessionMock.mockResolvedValue(undefined);
  });

  it("rejects requests with a missing Origin header", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "password123" }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(getUserByUsernameMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("rejects requests with an invalid Origin header", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://evil.example.com",
        },
        body: JSON.stringify({ username: "admin", password: "password123" }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(getUserByUsernameMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
