import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedSession } from "./session";

const {
  cookiesGetMock,
  cookiesSetMock,
  cookiesDeleteMock,
  verifyTokenMock,
  findUniqueMock,
} = vi.hoisted(() => ({
  cookiesGetMock: vi.fn(),
  cookiesSetMock: vi.fn(),
  cookiesDeleteMock: vi.fn(),
  verifyTokenMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: cookiesGetMock,
    set: cookiesSetMock,
    delete: cookiesDeleteMock,
  })),
}));

vi.mock("@/lib/auth/jwt", () => ({
  verifyToken: verifyTokenMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    JWT_EXPIRES_IN: "7d",
  },
}));

describe("session auth", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    cookiesGetMock.mockReturnValue(undefined);
    verifyTokenMock.mockResolvedValue(null);
    findUniqueMock.mockResolvedValue(null);
  });

  it("returns null outside test mode even when SKIP_AUTH=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SKIP_AUTH", "1");

    const { verifySession } = await import("./session");

    await expect(verifySession()).resolves.toBeNull();
  });

  it("allows auth bypass in test mode when SKIP_AUTH=1", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SKIP_AUTH", "1");

    const { verifySession } = await import("./session");

    await expect(verifySession()).resolves.toEqual({
      userId: "dev-user-id",
      username: "dev",
      sessionVersion: 0,
      isDevBypass: true,
    } satisfies VerifiedSession);
  });

  it("sets secure cookies based on production mode only", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const { createSession } = await import("./session");

    await createSession(
      { userId: "user-1", username: "alice", sessionVersion: 1 },
      "signed-token"
    );

    expect(cookiesSetMock).toHaveBeenCalledWith(
      "session",
      "signed-token",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: false,
      })
    );
  });

  it("sets secure cookies in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const { createSession } = await import("./session");

    await createSession(
      { userId: "user-1", username: "alice", sessionVersion: 1 },
      "signed-token"
    );

    expect(cookiesSetMock).toHaveBeenCalledWith(
      "session",
      "signed-token",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: true,
      })
    );
  });
});
