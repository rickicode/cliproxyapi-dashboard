import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  mockUseTranslations,
  mockUseRouter,
  mockUsePathname,
  mockUseSearchParams,
  mockUseToast,
} = vi.hoisted(() => ({
  mockUseTranslations: vi.fn(),
  mockUseRouter: vi.fn(),
  mockUsePathname: vi.fn(),
  mockUseSearchParams: vi.fn(),
  mockUseToast: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: (...args: Parameters<typeof mockUseTranslations>) => mockUseTranslations(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
  usePathname: () => mockUsePathname(),
  useSearchParams: () => mockUseSearchParams(),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => mockUseToast(),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-card>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div data-card-header>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div data-card-content>{children}</div>,
}));

vi.mock("@/components/connected-accounts/connected-accounts-toolbar", () => ({
  ConnectedAccountsToolbar: () => <div>TOOLBAR_RENDERED</div>,
}));

vi.mock("@/components/connected-accounts/connected-accounts-bulk-bar", () => ({
  ConnectedAccountsBulkBar: () => <div>BULK_BAR_RENDERED</div>,
}));

vi.mock("@/components/connected-accounts/connected-accounts-table", () => ({
  ConnectedAccountsTable: () => <div>TABLE_RENDERED</div>,
  getSelectableConnectedAccountsActionKeys: () => [],
}));

vi.mock("@/components/connected-accounts/connected-accounts-pagination", () => ({
  ConnectedAccountsPagination: () => <div>PAGINATION_RENDERED</div>,
}));

import { ConnectedAccountsPage } from "@/components/connected-accounts/connected-accounts-page";
import {
  buildConnectedAccountsSearch,
  createConnectedAccountsRuntime,
  loadConnectedAccountsPageData,
  refreshConnectedAccountsPageData,
  shouldRenderConnectedAccountsResults,
  submitConnectedAccountRowAction,
  type ConnectedAccountsQueryState,
} from "@/components/connected-accounts/connected-accounts-page-logic";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseQuery: ConnectedAccountsQueryState = {
  q: "claude",
  status: "disabled",
  page: 3,
  pageSize: 25,
};

afterEach(() => {
  vi.clearAllMocks();
});

mockUseTranslations.mockImplementation((namespace: string) => (key: string) => {
  if (namespace === "providers") {
    return {
      connectedAccountsTitle: "Connected Accounts",
      connectedAccountsDescription: "Active OAuth provider connections",
      toastOAuthLoadFailed: "Failed to load OAuth accounts",
    }[key] ?? key;
  }

  return {
    loading: "Loading...",
  }[key] ?? key;
});

mockUseRouter.mockReturnValue({
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
});
mockUsePathname.mockReturnValue("/dashboard/providers/connected-accounts");
mockUseSearchParams.mockReturnValue(new URLSearchParams(""));
mockUseToast.mockReturnValue({ showToast: vi.fn() });

describe("Connected Accounts page helpers", () => {
  it("handles a rejected initial page load by setting persistent error state, showing a toast, and clearing loading", async () => {
    const setData = vi.fn();
    const setLoadError = vi.fn();
    const setLoading = vi.fn();
    const showToast = vi.fn();
    const replaceQuery = vi.fn();
    const loadAbortControllerRef = { current: null as AbortController | null };
    const runtime = createConnectedAccountsRuntime({
      getLatestRequestId: () => 1,
    });

    await refreshConnectedAccountsPageData({
      nextQuery: {
        q: "",
        status: "all",
        page: 1,
        pageSize: 50,
      },
      requestId: 1,
      runtime,
      loadAbortControllerRef,
      replaceQuery,
      setData,
      setLoadError,
      setLoading,
      showToast,
      loadFailedMessage: "Failed to load OAuth accounts",
      loadData: vi.fn(async () => {
        throw new Error("oauth-list-500");
      }) as typeof loadConnectedAccountsPageData,
    });

    expect(setLoadError).toHaveBeenCalledTimes(2);
    expect(setLoadError).toHaveBeenNthCalledWith(1, null);
    expect(setLoadError).toHaveBeenNthCalledWith(2, "Failed to load OAuth accounts");
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("Failed to load OAuth accounts", "error");
    expect(setLoading).toHaveBeenCalledTimes(2);
    expect(setLoading).toHaveBeenNthCalledWith(1, true);
    expect(setLoading).toHaveBeenNthCalledWith(2, false);
    expect(setData).not.toHaveBeenCalled();
    expect(replaceQuery).not.toHaveBeenCalled();
    expect(loadAbortControllerRef.current).toBeNull();
  });

  it("suppresses the results branch when loading is complete but the initial load failed", () => {
    expect(
      shouldRenderConnectedAccountsResults({
        data: null,
        loadError: "Failed to load OAuth accounts",
      })
    ).toBe(false);

    expect(
      shouldRenderConnectedAccountsResults({
        data: {
          items: [],
          page: 1,
          pageSize: 50,
          total: 0,
          totalPages: 1,
          availableStatuses: [],
        },
        loadError: "Failed to load OAuth accounts",
      })
    ).toBe(true);

    expect(
      shouldRenderConnectedAccountsResults({
        data: null,
        loadError: null,
      })
    ).toBe(true);
  });

  it("renders the persistent inline alert branch and suppresses results when the initial load failed", () => {
    const markup = renderToStaticMarkup(
      <ConnectedAccountsPage
        initialState={{
          data: null,
          loading: false,
          loadError: "Failed to load OAuth accounts",
          selectedActionKeys: [],
          loadingActionKey: null,
          loadingBulkAction: null,
        }}
      />
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Failed to load OAuth accounts");
    expect(markup).toContain("TOOLBAR_RENDERED");
    expect(markup).toContain("BULK_BAR_RENDERED");
    expect(markup).not.toContain("TABLE_RENDERED");
    expect(markup).not.toContain("PAGINATION_RENDERED");
  });

  it("preserves query-string filters when refreshing after a row action", async () => {
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/providers/oauth/oauth-1") {
        expect(init).toMatchObject({
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: false }),
        });

        return jsonResponse({ success: true, disabled: false });
      }

      expect(url).toBe(
        "/api/providers/oauth?q=claude&status=disabled&page=3&pageSize=25"
      );

      return jsonResponse({
        success: true,
        data: {
          items: [
            {
              id: "oauth-1",
              actionKey: "oauth-1",
              accountName: "claude-1.json",
              accountEmail: "claude@example.com",
              provider: "Claude",
              ownerUsername: "ricki",
              ownerUserId: "user-1",
              isOwn: true,
              status: "active",
              statusMessage: null,
              unavailable: false,
              canToggle: true,
              canDelete: true,
              canClaim: false,
            },
          ],
          page: 3,
          pageSize: 25,
          total: 63,
          totalPages: 3,
          availableStatuses: ["active", "disabled"],
        },
      });
    };

    const result = await submitConnectedAccountRowAction({
      query: baseQuery,
      accountId: "oauth-1",
      action: "enable",
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.query).toEqual(baseQuery);
    expect(result.canonicalSearch).toBe("?q=claude&status=disabled&page=3&pageSize=25");
    expect(result.data.page).toBe(3);
  });

  it("falls back to the nearest valid page when current page exceeds totalPages", async () => {
    const result = await loadConnectedAccountsPageData({
      q: "codex",
      status: "active",
      page: 4,
      pageSize: 25,
      fetchImpl: (async (input: string | URL | Request) => {
        expect(String(input)).toBe(
          "/api/providers/oauth?q=codex&status=active&page=4&pageSize=25"
        );

        return jsonResponse({
          success: true,
          data: {
            items: [],
            page: 2,
            pageSize: 25,
            total: 40,
            totalPages: 2,
            availableStatuses: ["active", "disabled"],
          },
        });
      }) as typeof fetch,
    });

    expect(result.query).toEqual({
      q: "codex",
      status: "active",
      page: 2,
      pageSize: 25,
    });
    expect(result.canonicalSearch).toBe("?q=codex&status=active&page=2&pageSize=25");
  });

  it("passes through an abort signal for superseded list loads", async () => {
    const abortController = new AbortController();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(abortController.signal);

      return jsonResponse({
        success: true,
        data: {
          items: [],
          page: 1,
          pageSize: 25,
          total: 0,
          totalPages: 1,
          availableStatuses: ["active"],
        },
      });
    });

    await loadConnectedAccountsPageData({
      ...baseQuery,
      fetchImpl: fetchMock as typeof fetch,
      signal: abortController.signal,
    } as ConnectedAccountsQueryState & { fetchImpl?: typeof fetch; signal: AbortSignal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores stale older responses when a newer request is current", async () => {
    let latestRequestId = 2;
    const applied: string[] = [];
    const runtime = createConnectedAccountsRuntime({
      getLatestRequestId: () => latestRequestId,
    });

    const staleResult = {
      data: {
        items: [],
        page: 1,
        pageSize: 25,
        total: 1,
        totalPages: 1,
        availableStatuses: ["active"],
      },
      query: { q: "older", status: "active", page: 1, pageSize: 25 },
      canonicalSearch: buildConnectedAccountsSearch({
        q: "older",
        status: "active",
        page: 1,
        pageSize: 25,
      }),
    };

    const freshResult = {
      data: {
        items: [],
        page: 1,
        pageSize: 25,
        total: 2,
        totalPages: 1,
        availableStatuses: ["disabled"],
      },
      query: { q: "newer", status: "disabled", page: 1, pageSize: 25 },
      canonicalSearch: buildConnectedAccountsSearch({
        q: "newer",
        status: "disabled",
        page: 1,
        pageSize: 25,
      }),
    };

    runtime.applyResponse(1, staleResult, () => applied.push("stale-response"));
    runtime.applyError(1, () => applied.push("stale-error"));
    runtime.applyFinally(1, () => applied.push("stale-finally"));

    expect(applied).toEqual([]);

    latestRequestId = 2;
    runtime.applyResponse(2, freshResult, () => applied.push("fresh-response"));
    runtime.applyError(2, () => applied.push("fresh-error"));
    runtime.applyFinally(2, () => applied.push("fresh-finally"));

    expect(applied).toEqual(["fresh-response", "fresh-error", "fresh-finally"]);
  });
});
