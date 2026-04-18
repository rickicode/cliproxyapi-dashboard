import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const userFindUniqueMock = vi.fn();
const modelPreferenceFindUniqueMock = vi.fn();
const modelPreferenceUpsertMock = vi.fn();

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
    modelPreference: {
      findUnique: modelPreferenceFindUniqueMock,
      upsert: modelPreferenceUpsertMock,
    },
  },
}));

describe("PUT /api/model-preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    userFindUniqueMock.mockResolvedValue({ id: "user-1" });
    modelPreferenceUpsertMock.mockResolvedValue({ excludedModels: [] });
  });

  it("returns validation 400 when request JSON is malformed", async () => {
    const { PUT } = await import("./route");
    const response = await PUT(
      new NextRequest("http://localhost/api/model-preferences", {
        method: "PUT",
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
    expect(userFindUniqueMock).not.toHaveBeenCalled();
    expect(modelPreferenceUpsertMock).not.toHaveBeenCalled();
  });
});
