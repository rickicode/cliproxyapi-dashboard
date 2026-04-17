import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));

vi.mock("@/lib/errors", () => ({
  Errors: {
    unauthorized: () => NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 }),
    notFound: (resource = "Resource") =>
      NextResponse.json({ error: { message: `${resource} not found` } }, { status: 404 }),
    internal: (message: string) => NextResponse.json({ error: { message } }, { status: 500 }),
  },
}));

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns unauthorized when there is no session", async () => {
    verifySessionMock.mockResolvedValue(null);

    const { GET } = await import("./route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: { message: "Unauthorized" } });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("returns the authenticated user when verifySession succeeds and Prisma finds a row", async () => {
    const createdAt = new Date("2026-04-17T12:00:00.000Z");

    verifySessionMock.mockResolvedValue({
      userId: "user-1",
      username: "alice",
      sessionVersion: 1,
    });
    findUniqueMock.mockResolvedValue({
      id: "user-1",
      username: "alice",
      isAdmin: false,
      createdAt,
    });

    const { GET } = await import("./route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: {
        id: true,
        username: true,
        isAdmin: true,
        createdAt: true,
      },
    });
    expect(body).toEqual({
      id: "user-1",
      username: "alice",
      isAdmin: false,
      createdAt: createdAt.toISOString(),
    });
  });

  it("returns the synthetic dev user in test bypass mode even when Prisma has no matching row", async () => {
    verifySessionMock.mockResolvedValue({
      userId: "dev-user-id",
      username: "dev",
      sessionVersion: 0,
      isDevBypass: true,
    });
    findUniqueMock.mockResolvedValue(null);

    const { GET } = await import("./route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "dev-user-id",
      username: "dev",
      isAdmin: true,
      createdAt: expect.any(String),
    });
  });
});
