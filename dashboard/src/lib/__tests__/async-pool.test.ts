import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "@/lib/async-pool";

describe("mapWithConcurrency", () => {
  it("preserves result order while limiting concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    const input = [1, 2, 3, 4, 5];
    const result = await mapWithConcurrency(input, 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value * 2;
    });

    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("supports full parallelism when limit exceeds input size", async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (value) => value + 1);
    expect(result).toEqual([2, 3]);
  });
});
