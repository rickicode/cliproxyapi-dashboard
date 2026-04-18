import { describe, expect, it } from "vitest";

import { inferCanonicalOAuthProvider, normalizeOAuthAccountEmail } from "./migrate-provider-ownership";

describe("migrate-provider-ownership", () => {
  it("infers and canonicalizes provider when auth-file metadata is missing", () => {
    expect(
      inferCanonicalOAuthProvider({
        name: "claude-user@example.com.json",
        email: "user@example.com",
      })
    ).toBe("claude");
  });

  it("canonicalizes alias metadata when present", () => {
    expect(
      inferCanonicalOAuthProvider({
        name: "whatever.json",
        provider: "anthropic",
      })
    ).toBe("claude");
  });

  it("ignores non-meaningful metadata values and falls back to identifier inference", () => {
    expect(
      inferCanonicalOAuthProvider({
        name: "claude-user@example.com.json",
        provider: "unknown",
        email: "user@example.com",
      })
    ).toBe("claude");
  });

  it("falls back to unknown when provider cannot be inferred", () => {
    expect(
      inferCanonicalOAuthProvider({
        name: "mystery-account.json",
        email: "user@example.com",
      })
    ).toBe("unknown");
  });

  it("normalizes mixed-case OAuth emails on ingest", () => {
    expect(normalizeOAuthAccountEmail("  User@Example.COM ")).toBe("user@example.com");
    expect(normalizeOAuthAccountEmail("   ")).toBeNull();
    expect(normalizeOAuthAccountEmail(undefined)).toBeNull();
  });
});
