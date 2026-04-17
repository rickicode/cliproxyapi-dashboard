import { describe, expect, it } from "vitest";
import { parseAuthFilesResponse } from "./auth-files";

describe("parseAuthFilesResponse", () => {
  it("returns bare array payloads", () => {
    const files = [{ name: "direct.json" }];

    expect(parseAuthFilesResponse<{ name: string }>(files)).toEqual(files);
  });

  it("returns files payloads", () => {
    expect(
      parseAuthFilesResponse<{ name: string }>({
        files: [{ name: "wrapped.json" }],
      })
    ).toEqual([{ name: "wrapped.json" }]);
  });

  it("returns auth_files payloads", () => {
    expect(
      parseAuthFilesResponse<{ name: string }>({
        auth_files: [{ name: "legacy.json" }],
      })
    ).toEqual([{ name: "legacy.json" }]);
  });

  it("returns null when both wrappers are present but conflict", () => {
    expect(
      parseAuthFilesResponse<{ name: string }>({
        files: [{ name: "wrapped.json" }],
        auth_files: [{ name: "legacy.json" }],
      })
    ).toBeNull();
  });

  it("accepts matching dual wrappers when object key insertion order differs", () => {
    expect(
      parseAuthFilesResponse<{ name: string; provider: string }>({
        files: [{ name: "wrapped.json", provider: "claude" }],
        auth_files: [{ provider: "claude", name: "wrapped.json" }],
      })
    ).toEqual([{ name: "wrapped.json", provider: "claude" }]);
  });

  it("returns null when both wrappers are present and one is malformed", () => {
    expect(
      parseAuthFilesResponse<{ name: string }>({
        files: [{ name: "wrapped.json" }],
        auth_files: { invalid: true },
      })
    ).toBeNull();
  });

  it("falls back to an empty array for unsupported payloads", () => {
    expect(parseAuthFilesResponse<{ name: string }>({ invalid: true })).toEqual([]);
  });
});
