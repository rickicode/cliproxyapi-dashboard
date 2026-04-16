import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { QuotaAccount } from "@/lib/model-first-monitoring";
import enMessages from "../../../../messages/en.json";

const TEST_QUOTA_PAGE_SIZE = 25;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unmock("@/hooks/use-quota-data");
  vi.unmock("next/navigation");
  vi.unmock("next/dynamic");
  vi.unmock("@/components/quota/quota-toolbar");
  vi.unmock("@/components/quota/quota-details");
  vi.unmock("@/components/quota/quota-alerts");
  vi.unmock("@/components/ui/button");
  vi.unmock("@/components/ui/tooltip");
});

async function renderQuotaPage({
  summaryData,
  detailData,
  summaryLoading = false,
  detailLoading = false,
  detailError = null,
  search = "",
}: {
  summaryData: {
    providers: Array<{
      provider: string;
      monitorMode: "window-based" | "model-first";
      totalAccounts: number;
      activeAccounts: number;
      healthyAccounts: number;
      errorAccounts: number;
      windowCapacities: Array<{ id: string; label: string; capacity: number; resetTime: string | null; isShortTerm: boolean }>;
      modelFirstSummary?: unknown;
      lowCapacity: boolean;
    }>;
    totals: {
      activeAccounts: number;
      providerCount: number;
      lowCapacityCount: number;
    };
    warnings: Array<{ provider: string; count: number }>;
  } | null;
  detailData?: { accounts: QuotaAccount[] };
  summaryLoading?: boolean;
  detailLoading?: boolean;
  detailError?: Error | null;
  search?: string;
}) {
  const replace = vi.fn();

  vi.doMock("@/hooks/use-quota-data", () => ({
    useQuotaSummaryData: () => ({
      data: summaryData,
      isLoading: summaryLoading,
      error: null,
      refresh: vi.fn(),
    }),
    useQuotaDetailData: () => ({
      data: detailData,
      isLoading: detailLoading,
      error: detailError,
      refresh: vi.fn(),
    }),
  }));

  vi.doMock("next/navigation", () => ({
    useRouter: () => ({ replace }),
    usePathname: () => "/dashboard/quota",
    useSearchParams: () => new URLSearchParams(search),
  }));

  vi.doMock("next/dynamic", () => ({
    default: () =>
      function MockDynamicChart(props: unknown) {
        return <div data-testid="quota-chart">{JSON.stringify(props)}</div>;
      },
  }));

  vi.doMock("@/components/quota/quota-toolbar", () => ({
    QuotaToolbar: ({ total }: { total: number }) => <div data-testid="quota-toolbar">toolbar:{total}</div>,
  }));

  vi.doMock("@/components/quota/quota-details", () => ({
    QuotaDetails: (props: unknown) => <div data-testid="quota-details">{JSON.stringify(props)}</div>,
  }));

  vi.doMock("@/components/quota/quota-alerts", () => ({
    QuotaAlerts: () => <div data-testid="quota-alerts">alerts</div>,
  }));

  vi.doMock("@/components/ui/button", () => ({
    Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  }));

  vi.doMock("@/components/ui/tooltip", () => ({
    HelpTooltip: () => <span>?</span>,
  }));

  const { default: QuotaPage } = await import("@/app/dashboard/quota/page");

  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <QuotaPage />
    </NextIntlClientProvider>
  );

  return { markup, replace };
}

describe("Quota page helpers", () => {
  it("normalizes copilot aliases via the shared quota provider helper", async () => {
    const { normalizeQuotaProvider, getQuotaProviderLabel } = await import("@/lib/quota/provider");

    expect(normalizeQuotaProvider("github")).toBe("github-copilot");
    expect(normalizeQuotaProvider("copilot")).toBe("github-copilot");
    expect(normalizeQuotaProvider("github-copilot")).toBe("github-copilot");
    expect(normalizeQuotaProvider("claude")).toBe("claude");
    expect(getQuotaProviderLabel("github")).toBe("Copilot");
    expect(getQuotaProviderLabel("copilot")).toBe("Copilot");
    expect(getQuotaProviderLabel("github-copilot")).toBe("Copilot");
    expect(getQuotaProviderLabel("claude")).toBe("Claude");
  });

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

  it("resets page to 1 when search, provider, or status changes", async () => {
    const { buildQuotaToolbarQuery } = await import("@/app/dashboard/quota/page");

    expect(
      buildQuotaToolbarQuery(
        { q: "codex", provider: "claude", status: "warning", page: 4 },
        { q: "updated search" }
      )
    ).toEqual({ q: "updated search", provider: "claude", status: "warning", page: 1 });

    expect(
      buildQuotaToolbarQuery(
        { q: "codex", provider: "claude", status: "warning", page: 4 },
        { provider: "all" }
      )
    ).toEqual({ q: "codex", provider: "all", status: "warning", page: 1 });

    expect(
      buildQuotaToolbarQuery(
        { q: "codex", provider: "claude", status: "warning", page: 4 },
        { status: "active" }
      )
    ).toEqual({ q: "codex", provider: "claude", status: "active", page: 1 });
  });

  it("clears quota toolbar filters back to defaults", async () => {
    const { clearQuotaToolbarQuery } = await import("@/app/dashboard/quota/page");

    expect(
      clearQuotaToolbarQuery({ q: "codex", provider: "claude", status: "warning", page: 4 })
    ).toEqual({ q: "", provider: "all", status: "all", page: 1 });
  });

  it("filters quota accounts by search, provider, and status", async () => {
    const { filterQuotaAccounts } = await import("@/app/dashboard/quota/page");

    const accounts: QuotaAccount[] = [
      {
        auth_index: "claude-active",
        provider: "claude",
        email: "alpha@example.com",
        supported: true,
        groups: [{ id: "daily", label: "Daily", remainingFraction: 0.8, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
      },
      {
        auth_index: "codex-warning",
        provider: "codex",
        email: "beta@example.com",
        supported: true,
        groups: [{ id: "daily", label: "Daily", remainingFraction: 0.1, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
      },
      {
        auth_index: "copilot-error",
        provider: "github-copilot",
        email: "gamma@example.com",
        supported: true,
        error: "request failed",
        groups: [],
      },
      {
        auth_index: "kimi-disabled",
        provider: "kimi",
        email: "delta@example.com",
        supported: false,
        groups: [],
      },
    ];

    expect(
      filterQuotaAccounts(accounts, { q: "beta", provider: "all", status: "all", page: 3 }).map((account) => account.auth_index)
    ).toEqual(["codex-warning"]);

    expect(
      filterQuotaAccounts(accounts, { q: "", provider: "github-copilot", status: "error", page: 1 }).map(
        (account) => account.auth_index
      )
    ).toEqual(["copilot-error"]);

    expect(
      filterQuotaAccounts(accounts, { q: "", provider: "all", status: "disabled", page: 1 }).map(
        (account) => account.auth_index
      )
    ).toEqual(["kimi-disabled"]);
  });

  it("derives filtered summary metrics from the filtered account set", async () => {
    const { buildQuotaPageViewModel } = await import("@/app/dashboard/quota/page");

    const accounts: QuotaAccount[] = [
      {
        auth_index: "claude-active",
        provider: "claude",
        email: "alpha@example.com",
        supported: true,
        groups: [{ id: "daily", label: "Daily", remainingFraction: 0.8, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
      },
      {
        auth_index: "codex-warning",
        provider: "codex",
        email: "beta@example.com",
        supported: true,
        groups: [{ id: "daily", label: "Daily", remainingFraction: 0.1, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
      },
    ];

    const viewModel = buildQuotaPageViewModel({
      accounts,
      summaryWarnings: [{ provider: "codex", count: 2 }],
      query: { q: "beta", provider: "all", status: "all", page: 2 },
    });

    expect(viewModel.filteredAccounts.map((account) => account.auth_index)).toEqual(["codex-warning"]);
    expect(viewModel.activeAccounts).toBe(1);
    expect(viewModel.lowCapacityCount).toBe(1);
    expect(viewModel.providerSummaries).toHaveLength(1);
    expect(viewModel.providerSummaries[0]).toEqual(
      expect.objectContaining({ provider: "codex", totalAccounts: 1, activeAccounts: 1 })
    );
    expect(viewModel.modelFirstWarnings).toEqual([{ provider: "codex", count: 2 }]);
  });

  it("paginates only the filtered account list while keeping summary metrics based on the full filtered set", async () => {
    const { buildQuotaPageViewModel } = await import("@/app/dashboard/quota/page");

    const accounts: QuotaAccount[] = Array.from({ length: TEST_QUOTA_PAGE_SIZE + 1 }, (_, index) => ({
      auth_index: `account-${index + 1}`,
      provider: index % 2 === 0 ? "claude" : "codex",
      email: `user-${index + 1}@example.com`,
      supported: true,
      groups: [
        {
          id: "daily",
          label: "Daily",
          remainingFraction: index === 1 ? 0.1 : 0.8,
          resetTime: "2026-04-16T12:00:00.000Z",
          models: [],
        },
      ],
    }));

    const viewModel = buildQuotaPageViewModel({
      accounts,
      summaryWarnings: [],
      query: { q: "", provider: "all", status: "all", page: 2 },
    });

    expect(viewModel.filteredAccounts).toHaveLength(TEST_QUOTA_PAGE_SIZE + 1);
    expect(viewModel.paginatedAccounts.map((account) => account.auth_index)).toEqual([`account-${TEST_QUOTA_PAGE_SIZE + 1}`]);
    expect(viewModel.toolbarTotal).toBe(TEST_QUOTA_PAGE_SIZE + 1);
    expect(viewModel.activeAccounts).toBe(TEST_QUOTA_PAGE_SIZE + 1);
    expect(viewModel.lowCapacityCount).toBe(1);
    expect(viewModel.currentPage).toBe(2);
    expect(viewModel.totalPages).toBe(2);
  });

  it("normalizes page bounds safely for invalid and oversized page queries", async () => {
    const { buildQuotaPageViewModel } = await import("@/app/dashboard/quota/page");

    const accounts: QuotaAccount[] = Array.from({ length: TEST_QUOTA_PAGE_SIZE + 1 }, (_, index) => ({
      auth_index: `account-${index + 1}`,
      provider: index % 2 === 0 ? "claude" : "codex",
      email: `user-${index + 1}@example.com`,
      supported: true,
      groups: [{ id: "daily", label: "Daily", remainingFraction: 0.8, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
    }));

    const oversizedPage = buildQuotaPageViewModel({
      accounts,
      summaryWarnings: [],
      query: { q: "", provider: "all", status: "all", page: 99 },
    });

    expect(oversizedPage.currentPage).toBe(2);
    expect(oversizedPage.totalPages).toBe(2);
    expect(oversizedPage.paginatedAccounts.map((account) => account.auth_index)).toEqual([`account-${TEST_QUOTA_PAGE_SIZE + 1}`]);

    const emptyPage = buildQuotaPageViewModel({
      accounts: [],
      summaryWarnings: [],
      query: { q: "", provider: "all", status: "all", page: 5 },
    });

    expect(emptyPage.currentPage).toBe(1);
    expect(emptyPage.totalPages).toBe(1);
    expect(emptyPage.paginatedAccounts).toEqual([]);
  });

  it("collapses copilot aliases into one canonical provider summary bucket", async () => {
    const { buildQuotaPageViewModel, matchesSelectedProvider } = await import("@/app/dashboard/quota/page");

    const accounts: QuotaAccount[] = [
      {
        auth_index: "github-account",
        provider: "github",
        email: "github@example.com",
        supported: true,
        groups: [{ id: "daily", label: "Daily", remainingFraction: 0.8, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
      },
      {
        auth_index: "copilot-account",
        provider: "copilot",
        email: "copilot@example.com",
        supported: true,
        groups: [{ id: "daily", label: "Daily", remainingFraction: 0.6, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
      },
      {
        auth_index: "github-copilot-account",
        provider: "github-copilot",
        email: "gh-copilot@example.com",
        supported: true,
        groups: [{ id: "daily", label: "Daily", remainingFraction: 0.4, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
      },
    ];

    const viewModel = buildQuotaPageViewModel({
      accounts,
      summaryWarnings: [{ provider: "copilot", count: 3 }],
      query: { q: "", provider: "github-copilot", status: "all", page: 1 },
    });

    expect(viewModel.filteredAccounts.map((account) => account.auth_index)).toEqual([
      "github-account",
      "copilot-account",
      "github-copilot-account",
    ]);
    expect(viewModel.providerSummaries).toHaveLength(1);
    expect(viewModel.providerSummaries[0]).toEqual(
      expect.objectContaining({
        provider: "github-copilot",
        totalAccounts: 3,
        activeAccounts: 3,
      })
    );
    expect(viewModel.modelFirstWarnings).toEqual([{ provider: "copilot", count: 3 }]);
    expect(matchesSelectedProvider("github", "github-copilot")).toBe(true);
    expect(matchesSelectedProvider("copilot", "github-copilot")).toBe(true);
    expect(matchesSelectedProvider("github-copilot", "github-copilot")).toBe(true);
  });

  it("defers URL normalization until after render effects run", async () => {
    const effectCallbacks: Array<() => void> = [];
    const replace = vi.fn();

    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");

      return {
        ...actual,
        useEffect: (callback: () => void) => {
          effectCallbacks.push(callback);
        },
      };
    });

    vi.doMock("@/hooks/use-quota-data", () => ({
      useQuotaSummaryData: () => ({
        data: {
          providers: [
            {
              provider: "claude",
              monitorMode: "window-based" as const,
              totalAccounts: TEST_QUOTA_PAGE_SIZE + 1,
              activeAccounts: TEST_QUOTA_PAGE_SIZE + 1,
              healthyAccounts: TEST_QUOTA_PAGE_SIZE + 1,
              errorAccounts: 0,
              windowCapacities: [
                { id: "daily", label: "Daily", capacity: 0.8, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
              ],
              lowCapacity: false,
            },
          ],
          totals: {
            activeAccounts: TEST_QUOTA_PAGE_SIZE + 1,
            providerCount: 1,
            lowCapacityCount: 0,
          },
          warnings: [],
        },
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      }),
      useQuotaDetailData: () => ({
        data: {
          accounts: Array.from({ length: TEST_QUOTA_PAGE_SIZE + 1 }, (_, index) => ({
            auth_index: `account-${index + 1}`,
            provider: "claude",
            email: `user-${index + 1}@example.com`,
            supported: true,
            groups: [
              {
                id: "daily",
                label: "Daily",
                remainingFraction: 0.8,
                resetTime: "2026-04-16T12:00:00.000Z",
                models: [],
              },
            ],
          })),
        },
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      }),
    }));

    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ replace }),
      usePathname: () => "/dashboard/quota",
      useSearchParams: () => new URLSearchParams("page=999"),
    }));

    vi.doMock("next/dynamic", () => ({
      default: () =>
        function MockDynamicChart(props: unknown) {
          return <div data-testid="quota-chart">{JSON.stringify(props)}</div>;
        },
    }));

    vi.doMock("@/components/quota/quota-toolbar", () => ({
      QuotaToolbar: ({ total }: { total: number }) => <div data-testid="quota-toolbar">toolbar:{total}</div>,
    }));

    vi.doMock("@/components/quota/quota-details", () => ({
      QuotaDetails: (props: unknown) => <div data-testid="quota-details">{JSON.stringify(props)}</div>,
    }));

    vi.doMock("@/components/quota/quota-alerts", () => ({
      QuotaAlerts: () => <div data-testid="quota-alerts">alerts</div>,
    }));

    vi.doMock("@/components/ui/button", () => ({
      Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
    }));

    vi.doMock("@/components/ui/tooltip", () => ({
      HelpTooltip: () => <span>?</span>,
    }));

    const { default: QuotaPage } = await import("@/app/dashboard/quota/page");

    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <QuotaPage />
      </NextIntlClientProvider>
    );

    expect(replace).not.toHaveBeenCalled();
    expect(effectCallbacks).toHaveLength(1);

    effectCallbacks[0]();

    expect(replace).toHaveBeenCalledWith("/dashboard/quota?page=2", { scroll: false });
  });

  it("preserves summary cards and chart data when detail data is unavailable", async () => {
    const { markup } = await renderQuotaPage({
      summaryData: {
        providers: [
          {
            provider: "claude",
            monitorMode: "window-based",
            totalAccounts: 3,
            activeAccounts: 3,
            healthyAccounts: 3,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.75, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: false,
          },
          {
            provider: "codex",
            monitorMode: "window-based",
            totalAccounts: 2,
            activeAccounts: 2,
            healthyAccounts: 2,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.1, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: true,
          },
        ],
        totals: {
          activeAccounts: 5,
          providerCount: 2,
          lowCapacityCount: 1,
        },
        warnings: [],
      },
      detailData: undefined,
    });

    expect(markup).toContain("Active Accounts");
    expect(markup).toContain(">5<");
    expect(markup).toContain("Overall Capacity");
    expect(markup).toContain(">49%<");
    expect(markup).toContain(">1<");
    expect(markup).toContain(">2<");
    expect(markup).toContain('&quot;provider&quot;:&quot;claude&quot;');
    expect(markup).toContain('&quot;provider&quot;:&quot;codex&quot;');
    expect(markup).toContain('&quot;error&quot;:false');
    expect(markup).toContain('&quot;filteredAccounts&quot;:[]');
  });

  it("preserves provider-filtered summary cards and chart data when detail loading fails", async () => {
    const { markup } = await renderQuotaPage({
      summaryData: {
        providers: [
          {
            provider: "copilot",
            monitorMode: "window-based",
            totalAccounts: 4,
            activeAccounts: 4,
            healthyAccounts: 4,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.35, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: false,
          },
          {
            provider: "claude",
            monitorMode: "window-based",
            totalAccounts: 2,
            activeAccounts: 2,
            healthyAccounts: 2,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.9, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: false,
          },
        ],
        totals: {
          activeAccounts: 6,
          providerCount: 2,
          lowCapacityCount: 0,
        },
        warnings: [{ provider: "copilot", count: 2 }],
      },
      detailData: undefined,
      detailError: new Error("detail failed"),
      search: "provider=github-copilot&q=missing&status=warning&page=3",
    });

    expect(markup).toContain(">4<");
    expect(markup).toContain(">35%<");
    expect(markup).toContain('&quot;provider&quot;:&quot;github-copilot&quot;');
    expect(markup).not.toContain('&quot;provider&quot;:&quot;claude&quot;');
    expect(markup).toContain('&quot;error&quot;:true');
  });

  it("uses the shared provider label helper for warning presentation", async () => {
    const { markup } = await renderQuotaPage({
      summaryData: {
        providers: [
          {
            provider: "github-copilot",
            monitorMode: "window-based",
            totalAccounts: 2,
            activeAccounts: 2,
            healthyAccounts: 2,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.35, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: false,
          },
        ],
        totals: {
          activeAccounts: 2,
          providerCount: 1,
          lowCapacityCount: 0,
        },
        warnings: [{ provider: "github", count: 2 }],
      },
      detailData: undefined,
      detailError: new Error("detail failed"),
      search: "provider=github-copilot",
    });

    expect(markup).toContain("Copilot snapshot API currently returns full quota");
    expect(markup).not.toContain("Github snapshot API currently returns full quota");
    expect(markup).not.toContain("Github-copilot snapshot API currently returns full quota");
  });

  it("uses summary cards and chart data while detail is still loading", async () => {
    const { markup } = await renderQuotaPage({
      summaryData: {
        providers: [
          {
            provider: "claude",
            monitorMode: "window-based",
            totalAccounts: 3,
            activeAccounts: 3,
            healthyAccounts: 3,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.75, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: false,
          },
          {
            provider: "codex",
            monitorMode: "window-based",
            totalAccounts: 2,
            activeAccounts: 2,
            healthyAccounts: 2,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.1, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: true,
          },
        ],
        totals: {
          activeAccounts: 5,
          providerCount: 2,
          lowCapacityCount: 1,
        },
        warnings: [],
      },
      detailData: undefined,
      detailLoading: true,
    });

    expect(markup).toContain("Active Accounts");
    expect(markup).toContain(">5<");
    expect(markup).toContain("Overall Capacity");
    expect(markup).toContain(">49%<");
    expect(markup).toContain(">1<");
    expect(markup).toContain(">2<");
    expect(markup).toContain('&quot;provider&quot;:&quot;claude&quot;');
    expect(markup).toContain('&quot;provider&quot;:&quot;codex&quot;');
    expect(markup).toContain('&quot;loading&quot;:true');
  });

  it("does not show zero toolbar results in summary fallback mode", async () => {
    const { markup } = await renderQuotaPage({
      summaryData: {
        providers: [
          {
            provider: "copilot",
            monitorMode: "window-based",
            totalAccounts: 4,
            activeAccounts: 4,
            healthyAccounts: 4,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.35, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: false,
          },
          {
            provider: "claude",
            monitorMode: "window-based",
            totalAccounts: 2,
            activeAccounts: 2,
            healthyAccounts: 2,
            errorAccounts: 0,
            windowCapacities: [
              { id: "daily", label: "Daily", capacity: 0.9, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
            ],
            lowCapacity: false,
          },
        ],
        totals: {
          activeAccounts: 6,
          providerCount: 2,
          lowCapacityCount: 0,
        },
        warnings: [{ provider: "copilot", count: 2 }],
      },
      detailData: undefined,
      detailError: new Error("detail failed"),
      search: "provider=github-copilot&q=missing&status=warning&page=3",
    });

    expect(markup).toContain("toolbar:4");
    expect(markup).not.toContain("toolbar:0");
    expect(markup).toContain(">4<");
  });

  it("collapses copilot provider aliases into one summary bucket in summary fallback mode", async () => {
    const { buildQuotaSummaryFallbackViewModel } = await import("@/app/dashboard/quota/page");

    const viewModel = buildQuotaSummaryFallbackViewModel({
      providerSummaries: [
        {
          provider: "github",
          monitorMode: "window-based",
          totalAccounts: 1,
          activeAccounts: 1,
          healthyAccounts: 1,
          errorAccounts: 0,
          windowCapacities: [
            { id: "daily", label: "Daily", capacity: 0.7, resetTime: "2026-04-16T12:00:00.000Z", isShortTerm: false },
          ],
          lowCapacity: false,
        },
        {
          provider: "copilot",
          monitorMode: "window-based",
          totalAccounts: 2,
          activeAccounts: 1,
          healthyAccounts: 1,
          errorAccounts: 1,
          windowCapacities: [
            { id: "daily", label: "Daily", capacity: 0.2, resetTime: "2026-04-16T13:00:00.000Z", isShortTerm: false },
          ],
          lowCapacity: false,
        },
        {
          provider: "github-copilot",
          monitorMode: "window-based",
          totalAccounts: 3,
          activeAccounts: 2,
          healthyAccounts: 2,
          errorAccounts: 1,
          windowCapacities: [
            { id: "daily", label: "Daily", capacity: 0.1, resetTime: "2026-04-16T14:00:00.000Z", isShortTerm: false },
          ],
          lowCapacity: true,
        },
      ],
      summaryWarnings: [{ provider: "copilot", count: 2 }],
      query: { q: "missing", provider: "github-copilot", status: "warning", page: 3 },
    });

    expect(viewModel.providerSummaries).toHaveLength(1);
    expect(viewModel.providerSummaries[0]).toEqual(
      expect.objectContaining({
        provider: "github-copilot",
        totalAccounts: 6,
        activeAccounts: 4,
        healthyAccounts: 4,
        errorAccounts: 2,
        lowCapacity: true,
        windowCapacities: [
          expect.objectContaining({ id: "daily", capacity: 0.1 }),
        ],
      })
    );
    expect(viewModel.toolbarTotal).toBe(6);
    expect(viewModel.activeAccounts).toBe(4);
    expect(viewModel.lowCapacityCount).toBe(1);
    expect(viewModel.hasAnyAccounts).toBe(true);
    expect(viewModel.modelFirstWarnings).toEqual([{ provider: "copilot", count: 2 }]);
  });

  it("passes paginated accounts to details while summary cards and chart use pre-pagination totals", async () => {
    const detailAccounts: QuotaAccount[] = Array.from({ length: TEST_QUOTA_PAGE_SIZE + 1 }, (_, index) => ({
      auth_index: `account-${index + 1}`,
      provider: index % 3 === 0 ? "claude" : index % 3 === 1 ? "codex" : "github-copilot",
      email: `user-${index + 1}@example.com`,
      supported: true,
      groups: [
        {
          id: "daily",
          label: "Daily",
          remainingFraction: index === 1 ? 0.1 : 0.6,
          resetTime: "2026-04-16T12:00:00.000Z",
          models: [],
        },
      ],
    }));

    const summaryProviders = ["claude", "codex", "github-copilot"].map((provider, index) => ({
      provider,
      monitorMode: "window-based" as const,
      totalAccounts: Math.floor((TEST_QUOTA_PAGE_SIZE + 1) / 3) + ((TEST_QUOTA_PAGE_SIZE + 1) % 3 > index ? 1 : 0),
      activeAccounts: Math.floor((TEST_QUOTA_PAGE_SIZE + 1) / 3) + ((TEST_QUOTA_PAGE_SIZE + 1) % 3 > index ? 1 : 0),
      healthyAccounts: Math.floor((TEST_QUOTA_PAGE_SIZE + 1) / 3) + ((TEST_QUOTA_PAGE_SIZE + 1) % 3 > index ? 1 : 0),
      errorAccounts: 0,
      windowCapacities: [
        {
          id: "daily",
          label: "Daily",
          capacity: provider === "codex" ? 0.1 : 0.6,
          resetTime: "2026-04-16T12:00:00.000Z",
          isShortTerm: false,
        },
      ],
      lowCapacity: provider === "codex",
    }));

    const { markup } = await renderQuotaPage({
      summaryData: {
        providers: summaryProviders,
        totals: {
          activeAccounts: TEST_QUOTA_PAGE_SIZE + 1,
          providerCount: 3,
          lowCapacityCount: 1,
        },
        warnings: [],
      },
      detailData: { accounts: detailAccounts },
      search: "page=2",
    });

    expect(markup).toContain(`toolbar:${TEST_QUOTA_PAGE_SIZE + 1}`);
    expect(markup).toContain(`>${TEST_QUOTA_PAGE_SIZE + 1}<`);
    expect(markup).toContain('&quot;provider&quot;:&quot;claude&quot;');
    expect(markup).toContain('&quot;provider&quot;:&quot;codex&quot;');
    expect(markup).toContain('&quot;provider&quot;:&quot;github-copilot&quot;');
    expect(markup).toContain(`&quot;filteredAccounts&quot;:[{&quot;auth_index&quot;:&quot;account-${TEST_QUOTA_PAGE_SIZE + 1}&quot;`);
    expect(markup).toContain('&quot;currentPage&quot;:2');
    expect(markup).toContain('&quot;totalPages&quot;:2');
    expect(markup).toContain('&quot;hasAnyAccounts&quot;:true');
  });
});
