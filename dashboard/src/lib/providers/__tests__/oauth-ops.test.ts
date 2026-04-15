import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/generated/prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code = "P2002";
    },
  },
}));

vi.mock("@/lib/cache", () => ({
  invalidateUsageCaches: vi.fn(),
  invalidateProxyModelsCache: vi.fn(),
}));

vi.mock("@/lib/providers/management-api", () => ({
  MANAGEMENT_BASE_URL: "http://localhost:8317",
  MANAGEMENT_API_KEY: "test-key",
  FETCH_TIMEOUT_MS: 1000,
  fetchWithTimeout: vi.fn(),
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
}));

import { buildCodexBulkImportFileContent, buildCodexBulkImportFileName } from "@/lib/providers/oauth-ops";

describe("buildCodexBulkImportFileName", () => {
  it("builds a codex-prefixed file name from email", () => {
    expect(buildCodexBulkImportFileName("user@example.com")).toBe("codex_user@example.com.json");
  });

  it("sanitizes unsafe file-name characters", () => {
    expect(buildCodexBulkImportFileName("user/name+tag@example.com")).toBe("codex_user%2Fname+tag@example.com.json");
  });

  it("does not collide for distinct valid email addresses", () => {
    const plusAddress = buildCodexBulkImportFileName("user+tag@example.com");
    const underscoreAddress = buildCodexBulkImportFileName("user_tag@example.com");

    expect(plusAddress).not.toBe(underscoreAddress);
  });
});

describe("buildCodexBulkImportFileContent", () => {
  it("adds the codex type and preserves email for CLIProxyAPI auth-file detection", () => {
    expect(
      JSON.parse(
        buildCodexBulkImportFileContent({
          email: "user@example.com",
          access_token: "token",
          refresh_token: "refresh",
        })
      )
    ).toEqual({
      type: "codex",
      email: "user@example.com",
      access_token: "token",
      refresh_token: "refresh",
    });
  });
});
