import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const checkRateLimitWithPresetMock = vi.fn();
const hashPasswordMock = vi.fn();
const signTokenMock = vi.fn();
const createSessionMock = vi.fn();
const getUserCountMock = vi.fn();
const userCountMock = vi.fn();
const userCreateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: checkRateLimitWithPresetMock,
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: hashPasswordMock,
}));

vi.mock("@/lib/auth/jwt", () => ({
  signToken: signTokenMock,
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: createSessionMock,
}));

vi.mock("@/lib/auth/dal", () => ({
  getUserCount: getUserCountMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/errors", () => ({
  ERROR_CODE: {
    VALIDATION_INVALID_FORMAT: "VALIDATION_INVALID_FORMAT",
    SETUP_ALREADY_COMPLETED: "SETUP_ALREADY_COMPLETED",
  },
  Errors: {
    validation: (message: string) => new Response(JSON.stringify({ error: message }), { status: 400 }),
    missingFields: (fields: string[]) =>
      new Response(JSON.stringify({ error: `Missing required fields: ${fields.join(", ")}` }), { status: 400 }),
    rateLimited: () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
    internal: (message: string) => new Response(JSON.stringify({ error: message }), { status: 500 }),
  },
  apiError: (_code: string, message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), { status }),
}));

describe("POST /api/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true });
    hashPasswordMock.mockResolvedValue("hashed-password");
    signTokenMock.mockResolvedValue("signed-token");
    createSessionMock.mockResolvedValue(undefined);
    userCountMock.mockResolvedValue(0);
    userCreateMock.mockResolvedValue({
      id: "user-1",
      username: "admin",
      sessionVersion: 1,
    });
    transactionMock.mockImplementation(async (callback: (tx: { user: { count: typeof userCountMock; create: typeof userCreateMock } }) => Promise<unknown>) =>
      callback({
        user: {
          count: userCountMock,
          create: userCreateMock,
        },
      })
    );
  });

  it("rejects requests with a missing Origin header", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "password123" }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(hashPasswordMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects requests with an invalid Origin header", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/setup", {
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
    expect(hashPasswordMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
