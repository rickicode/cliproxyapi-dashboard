import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

async function useRealValidateOrigin() {
  const actual = await vi.importActual<typeof import("@/lib/auth/origin")>("@/lib/auth/origin");
  validateOriginMock.mockImplementation(actual.validateOrigin);
}

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const cookiesMock = vi.fn();
const setCookieMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/errors", () => ({
  Errors: {
    unauthorized: () => new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }),
    validation: (message: string) =>
      new Response(JSON.stringify({ error: { message } }), { status: 400 }),
  },
}));

describe("POST /api/set-locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    cookiesMock.mockResolvedValue({ set: setCookieMock });
  });

  it("returns 400 when request JSON is malformed", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/set-locale", {
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
    expect(data.error.message).toBe("Invalid JSON body");
    expect(setCookieMock).not.toHaveBeenCalled();
  });

  it("returns 403 for invalid origin", async () => {
    await useRealValidateOrigin();

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/set-locale", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example.com",
        },
        body: JSON.stringify({ locale: "en" }),
      })
    );
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe("Forbidden");
    expect(setCookieMock).not.toHaveBeenCalled();
  });
});
