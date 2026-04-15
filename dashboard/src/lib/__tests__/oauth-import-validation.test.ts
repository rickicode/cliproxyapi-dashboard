import { describe, expect, it } from "vitest";
import { parseOAuthImportJson } from "@/lib/oauth-import-validation";

const t = (key: string) => key;

describe("parseOAuthImportJson", () => {
  it("rejects duplicate codex emails before submit", () => {
    const result = parseOAuthImportJson(
      "codex",
      JSON.stringify([
        { email: "user@example.com", access_token: "a" },
        { email: " user@example.com ", access_token: "b" },
      ]),
      t
    );

    expect(result).toEqual({
      ok: false,
      error: "errorBulkCodexDuplicateEmail",
    });
  });

  it("accepts codex bulk entries with distinct emails", () => {
    const result = parseOAuthImportJson(
      "codex",
      JSON.stringify([
        { email: "user1@example.com", access_token: "a" },
        { email: "user2@example.com", access_token: "b" },
      ]),
      t
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("bulk");
    }
  });
});
