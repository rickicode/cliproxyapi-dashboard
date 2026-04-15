import { beforeEach, describe, expect, it, vi } from "vitest";

const useSWRMock = vi.fn();

vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
}));

vi.mock("swr", () => ({
  default: useSWRMock,
}));

describe("useQuotaData", () => {
  beforeEach(() => {
    useSWRMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses separate SWR keys for summary and detail quota data", async () => {
    useSWRMock.mockReturnValue({ data: null, mutate: vi.fn() });

    const {
      useQuotaSummaryData,
      useQuotaDetailData,
      QUOTA_SUMMARY_SWR_KEY,
      QUOTA_DETAIL_SWR_KEY,
    } = await import("@/hooks/use-quota-data");

    useQuotaSummaryData({ refreshInterval: 120_000 });
    useQuotaDetailData({ refreshInterval: 120_000 });

    expect(useSWRMock).toHaveBeenNthCalledWith(
      1,
      QUOTA_SUMMARY_SWR_KEY,
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 120_000,
        dedupingInterval: 30_000,
        revalidateOnFocus: false,
      })
    );

    expect(useSWRMock).toHaveBeenNthCalledWith(
      2,
      QUOTA_DETAIL_SWR_KEY,
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 120_000,
        dedupingInterval: 30_000,
        revalidateOnFocus: false,
      })
    );
  });

  it("keeps useQuotaData as an explicit alias of the detail hook", async () => {
    useSWRMock.mockReturnValue({ data: null, mutate: vi.fn() });

    const { useQuotaData, QUOTA_DETAIL_SWR_KEY } = await import("@/hooks/use-quota-data");

    useQuotaData({ refreshInterval: 45_000 });

    expect(useSWRMock).toHaveBeenCalledWith(
      QUOTA_DETAIL_SWR_KEY,
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 45_000,
        dedupingInterval: 30_000,
        revalidateOnFocus: false,
      })
    );
  });

  it("buildBustUrl appends bust safely for keys with existing query params", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234567890);

    const { buildBustUrl } = await import("@/hooks/use-quota-data");

    expect(buildBustUrl("/api/quota?view=summary")).toBe("/api/quota?view=summary&bust=1234567890");
    expect(buildBustUrl("/api/quota?view=detail")).toBe("/api/quota?view=detail&bust=1234567890");
  });

  it("buildBustUrl appends bust safely for keys without query params", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9876543210);

    const { buildBustUrl } = await import("@/hooks/use-quota-data");

    expect(buildBustUrl("/api/quota")).toBe("/api/quota?bust=9876543210");
  });

  it("refresh(true) for summary busts the summary key and repopulates the summary cache", async () => {
    const mutateMock = vi.fn();
    useSWRMock.mockReturnValue({ data: null, mutate: mutateMock });

    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accounts: [], generatedAt: "2026-04-15T00:00:00.000Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { useQuotaSummaryData } = await import("@/hooks/use-quota-data");

    const result = useQuotaSummaryData();
    await result.refresh(true);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const [mutation, options] = mutateMock.mock.calls[0] ?? [];
    expect(options).toEqual({ revalidate: false, populateCache: true });

    await mutation;

    expect(fetchMock).toHaveBeenCalledWith("/api/quota?view=summary&bust=1234567890");
  });

  it("refresh(true) for detail busts the detail key and repopulates the detail cache", async () => {
    const mutateMock = vi.fn();
    useSWRMock.mockReturnValue({ data: null, mutate: mutateMock });

    vi.spyOn(Date, "now").mockReturnValue(9876543210);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accounts: [], generatedAt: "2026-04-15T00:00:00.000Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { useQuotaDetailData } = await import("@/hooks/use-quota-data");

    const result = useQuotaDetailData();
    await result.refresh(true);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const [mutation, options] = mutateMock.mock.calls[0] ?? [];
    expect(options).toEqual({ revalidate: false, populateCache: true });

    await mutation;

    expect(fetchMock).toHaveBeenCalledWith("/api/quota?view=detail&bust=9876543210");
  });

  it("quotaFetcher returns parsed JSON for successful responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ providers: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { quotaFetcher } = await import("@/hooks/use-quota-data");

    await expect(quotaFetcher("/api/quota?view=summary")).resolves.toEqual({ providers: [] });
  });

  it("quotaFetcher throws for non-ok responses so SWR can expose detail errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    vi.stubGlobal("fetch", fetchMock);

    const { quotaFetcher } = await import("@/hooks/use-quota-data");

    await expect(quotaFetcher("/api/quota?view=detail")).rejects.toThrow(
      "Quota request failed: 500 Internal Server Error"
    );
  });

  it("quotaFetcher propagates network failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { quotaFetcher } = await import("@/hooks/use-quota-data");

    await expect(quotaFetcher("/api/quota?view=detail")).rejects.toThrow("network down");
  });
});
