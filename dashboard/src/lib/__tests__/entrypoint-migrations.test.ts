import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("dashboard entrypoint migrations", () => {
  it("guards revokedAt cleanup behind a column existence check", () => {
    const entrypointPath = path.resolve(process.cwd(), "entrypoint.sh");
    const script = fs.readFileSync(entrypointPath, "utf8");

    expect(script).toContain("IF EXISTS (");
    expect(script).toContain("information_schema.columns");
    expect(script).toContain('column_name = \'revokedAt\'');
  });
});
