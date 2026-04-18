import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const userFindUniqueMock = vi.fn();
const loggerErrorMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: loggerErrorMock,
  },
}));

describe("POST /api/update/dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "admin-1" });
    validateOriginMock.mockReturnValue(null);
    userFindUniqueMock.mockResolvedValue({ isAdmin: true });
  });

  it("returns validation 400 when request JSON is malformed", async () => {
    const fetchMock = vi.fn();
    Object.defineProperty(global, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update/dashboard", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: "{",
      })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid JSON body",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});
