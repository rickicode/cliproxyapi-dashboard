import { beforeEach, describe, expect, it, vi } from "vitest";

describe("healthFetcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves degraded JSON payloads for non-ok health responses", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(145);

    const degradedPayload = {
      status: "degraded",
      database: "error",
      proxy: "connected",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve(degradedPayload),
      })
    );

    const { healthFetcher } = await import("@/hooks/use-health-status");

    await expect(healthFetcher("/api/health")).resolves.toEqual({
      healthy: false,
      latencyMs: 45,
      raw: degradedPayload,
    });
  });
});
