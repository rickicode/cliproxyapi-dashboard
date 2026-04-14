import { describe, expect, it } from "vitest";
import { inferOAuthProviderFromIdentifiers, isMeaningfulProviderValue } from "@/lib/providers/provider-inference";

describe("provider inference", () => {
  it("infers codex from bulk import file names using underscore", () => {
    expect(inferOAuthProviderFromIdentifiers("codex_user@example.com.json")).toBe("codex");
  });

  it("treats unknown as non-meaningful provider metadata", () => {
    expect(isMeaningfulProviderValue("unknown")).toBe(false);
  });
});
