import { describe, expect, it } from "vitest";
import vitestConfig from "../../../vitest.config";

describe("vitest config", () => {
  it("excludes nested worktree and e2e spec paths", () => {
    const exclude = vitestConfig.test?.exclude ?? [];

    expect(exclude).toContain("**/tests/e2e/**");
    expect(exclude).toContain("**/.worktrees/**");
  });
});
