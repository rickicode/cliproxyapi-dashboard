import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

async function useRealValidateOrigin() {
  const actual = await vi.importActual<typeof import("@/lib/auth/origin")>("@/lib/auth/origin");
  validateOriginMock.mockImplementation(actual.validateOrigin);
}

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const resyncCustomProvidersMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/providers/resync", () => ({
  resyncCustomProviders: resyncCustomProvidersMock,
}));

vi.mock("@/lib/errors", () => ({
  Errors: {
    unauthorized: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  },
}));

describe("POST /api/custom-providers/resync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    resyncCustomProvidersMock.mockResolvedValue([]);
  });

  it("returns 403 when Origin header is omitted", async () => {
    await useRealValidateOrigin();

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/custom-providers/resync", {
        method: "POST",
      })
    );
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe("Forbidden");
    expect(resyncCustomProvidersMock).not.toHaveBeenCalled();
  });
});
