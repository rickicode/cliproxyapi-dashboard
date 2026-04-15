import { describe, expect, it, vi } from "vitest";

describe("Quota page helpers", () => {
  it("matches raw copilot provider alias when Copilot filter is selected", async () => {
    const { matchesSelectedProvider } = await import("@/app/dashboard/quota/page");

    expect(matchesSelectedProvider("copilot", "github-copilot")).toBe(true);
  });

  it("waits for both refreshes without rejecting when one fails", async () => {
    const { refreshAllQuotaData } = await import("@/app/dashboard/quota/page");

    const summaryRefresh = vi.fn().mockRejectedValue(new Error("summary failed"));
    const detailRefresh = vi.fn().mockResolvedValue({ ok: true });

    await expect(refreshAllQuotaData(summaryRefresh, detailRefresh)).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "fulfilled", value: { ok: true } }),
    ]);
  });

  it("waits for both refreshes without rejecting when both fail", async () => {
    const { refreshAllQuotaData } = await import("@/app/dashboard/quota/page");

    const summaryRefresh = vi.fn().mockRejectedValue(new Error("summary failed"));
    const detailRefresh = vi.fn().mockRejectedValue(new Error("detail failed"));

    await expect(refreshAllQuotaData(summaryRefresh, detailRefresh)).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
  });
});
