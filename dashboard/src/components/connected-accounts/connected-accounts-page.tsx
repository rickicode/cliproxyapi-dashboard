"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import type { OAuthListItem, OAuthListResponseData } from "@/lib/providers/oauth-listing";
import { ConnectedAccountsToolbar } from "@/components/connected-accounts/connected-accounts-toolbar";
import { ConnectedAccountsTable } from "@/components/connected-accounts/connected-accounts-table";
import { ConnectedAccountsBulkBar } from "@/components/connected-accounts/connected-accounts-bulk-bar";
import { ConnectedAccountsPagination } from "@/components/connected-accounts/connected-accounts-pagination";
import { getSelectableConnectedAccountsActionKeys } from "@/components/connected-accounts/connected-accounts-table";

export interface ConnectedAccountsQueryState {
  q: string;
  status: string;
  page: number;
  pageSize: number;
}

interface ConnectedAccountsEnvelope {
  data?: OAuthListResponseData;
}

interface BulkActionEnvelope {
  data?: {
    summary?: {
      total: number;
      successCount: number;
      failureCount: number;
    };
    failures?: Array<{ actionKey: string; reason: string }>;
  };
}

const DEFAULT_QUERY: ConnectedAccountsQueryState = {
  q: "",
  status: "all",
  page: 1,
  pageSize: 50,
};

function parsePositiveInteger(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseConnectedAccountsQuery(searchParams: URLSearchParams | ReadonlyURLSearchParamsLike): ConnectedAccountsQueryState {
  return {
    q: searchParams.get("q") ?? DEFAULT_QUERY.q,
    status: searchParams.get("status") ?? DEFAULT_QUERY.status,
    page: parsePositiveInteger(searchParams.get("page"), DEFAULT_QUERY.page),
    pageSize: parsePositiveInteger(searchParams.get("pageSize"), DEFAULT_QUERY.pageSize),
  };
}

interface ReadonlyURLSearchParamsLike {
  get(name: string): string | null;
}

export function buildConnectedAccountsSearch(query: ConnectedAccountsQueryState) {
  const params = new URLSearchParams();

  if (query.q) params.set("q", query.q);
  if (query.status !== DEFAULT_QUERY.status) params.set("status", query.status);
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));

  const search = params.toString();
  return search ? `?${search}` : "";
}

async function parseListResponse(response: Response) {
  if (!response.ok) {
    throw new Error(`oauth-list-${response.status}`);
  }

  const body = (await response.json()) as ConnectedAccountsEnvelope;
  if (!body.data) {
    throw new Error("oauth-list-invalid-response");
  }

  return body.data;
}

export async function loadConnectedAccountsPageData({
  q,
  status,
  page,
  pageSize,
  fetchImpl = fetch,
  signal,
}: ConnectedAccountsQueryState & { fetchImpl?: typeof fetch; signal?: AbortSignal }) {
  const requestedQuery = { q, status, page, pageSize };
  const response = await fetchImpl(
    `${API_ENDPOINTS.PROVIDERS.OAUTH}${buildConnectedAccountsSearch(requestedQuery)}`,
    { signal }
  );
  const data = await parseListResponse(response);
  const canonicalQuery = {
    q,
    status,
    page: data.page,
    pageSize: data.pageSize,
  };

  return {
    data,
    query: canonicalQuery,
    canonicalSearch: buildConnectedAccountsSearch(canonicalQuery),
  };
}

export async function submitConnectedAccountRowAction({
  query,
  accountId,
  action,
  fetchImpl = fetch,
}: {
  query: ConnectedAccountsQueryState;
  accountId: string;
  action: "enable" | "disable" | "disconnect";
  fetchImpl?: typeof fetch;
}) {
  const response =
    action === "disconnect"
      ? await fetchImpl(`${API_ENDPOINTS.PROVIDERS.OAUTH}/${accountId}`, { method: "DELETE" })
      : await fetchImpl(`${API_ENDPOINTS.PROVIDERS.OAUTH}/${accountId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: action === "disable" }),
        });

  if (!response.ok) {
    throw new Error(`oauth-row-action-${response.status}`);
  }

  return loadConnectedAccountsPageData({ ...query, fetchImpl });
}

export interface ConnectedAccountsStateSnapshot {
  data: OAuthListResponseData | null;
  loading: boolean;
  selectedActionKeys: string[];
  loadingActionKey: string | null;
  loadingBulkAction: string | null;
}

export interface ConnectedAccountsRuntime {
  applyResponse: (
    requestId: number,
    result: Awaited<ReturnType<typeof loadConnectedAccountsPageData>>,
    handler: (result: Awaited<ReturnType<typeof loadConnectedAccountsPageData>>) => void
  ) => void;
  applyRowActionSuccess: (
    requestId: number,
    result: Awaited<ReturnType<typeof submitConnectedAccountRowAction>>,
    handler: (result: Awaited<ReturnType<typeof submitConnectedAccountRowAction>>) => void
  ) => void;
  applyBulkActionSuccess: (
    requestId: number,
    result: Awaited<ReturnType<typeof submitConnectedAccountsBulkAction>>,
    handler: (result: Awaited<ReturnType<typeof submitConnectedAccountsBulkAction>>) => void
  ) => void;
  applyError: (requestId: number, handler: () => void) => void;
  applyFinally: (requestId: number, handler: () => void) => void;
}

export function createConnectedAccountsRuntime({
  getLatestRequestId,
}: {
  getLatestRequestId: () => number;
}): ConnectedAccountsRuntime {
  const isCurrentRequest = (requestId: number) => requestId === getLatestRequestId();

  return {
    applyResponse(requestId, result, handler) {
      if (!isCurrentRequest(requestId)) return;
      handler(result);
    },
    applyRowActionSuccess(requestId, result, handler) {
      if (!isCurrentRequest(requestId)) return;
      handler(result);
    },
    applyBulkActionSuccess(requestId, result, handler) {
      if (!isCurrentRequest(requestId)) return;
      handler(result);
    },
    applyError(requestId, handler) {
      if (!isCurrentRequest(requestId)) return;
      handler();
    },
    applyFinally(requestId, handler) {
      if (!isCurrentRequest(requestId)) return;
      handler();
    },
  };
}

async function submitConnectedAccountsBulkAction({
  query,
  actionKeys,
  action,
  fetchImpl = fetch,
}: {
  query: ConnectedAccountsQueryState;
  actionKeys: string[];
  action: "enable" | "disable" | "disconnect";
  fetchImpl?: typeof fetch;
}) {
  const response = await fetchImpl(API_ENDPOINTS.PROVIDERS.OAUTH_BULK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, actionKeys }),
  });

  if (!response.ok && response.status !== 207) {
    throw new Error(`oauth-bulk-action-${response.status}`);
  }

  const body = (await response.json()) as BulkActionEnvelope;

  const refreshed = await loadConnectedAccountsPageData({ ...query, fetchImpl });

  return {
    refreshed,
    summary: body.data?.summary,
  };
}

function updateSelection(current: string[], actionKey: string, checked: boolean) {
  if (checked) {
    return current.includes(actionKey) ? current : [...current, actionKey];
  }

  return current.filter((entry) => entry !== actionKey);
}

export function ConnectedAccountsPage() {
  const t = useTranslations("providers");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const query = useMemo(() => parseConnectedAccountsQuery(searchParams), [searchParams]);
  const [data, setData] = useState<OAuthListResponseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedActionKeys, setSelectedActionKeys] = useState<string[]>([]);
  const [loadingActionKey, setLoadingActionKey] = useState<string | null>(null);
  const [loadingBulkAction, setLoadingBulkAction] = useState<string | null>(null);
  const latestRequestIdRef = useRef(0);
  const loadAbortControllerRef = useRef<AbortController | null>(null);

  const nextRequestId = useCallback(() => {
    latestRequestIdRef.current += 1;
    return latestRequestIdRef.current;
  }, []);

  const getLatestRequestId = useCallback(() => latestRequestIdRef.current, []);

  const runtime = useMemo(
    () =>
      createConnectedAccountsRuntime({
        getLatestRequestId,
      }),
    [getLatestRequestId]
  );

  const replaceQuery = useCallback(
    (nextQuery: ConnectedAccountsQueryState) => {
      const nextSearch = buildConnectedAccountsSearch(nextQuery);
      router.replace(`${pathname}${nextSearch}`, { scroll: false });
    },
    [pathname, router]
  );

  const refreshData = useCallback(
    async (nextQuery: ConnectedAccountsQueryState) => {
      const requestId = nextRequestId();
      loadAbortControllerRef.current?.abort();
      const controller = new AbortController();
      loadAbortControllerRef.current = controller;
      setLoading(true);
      try {
        const result = await loadConnectedAccountsPageData({ ...nextQuery, signal: controller.signal });
        runtime.applyResponse(requestId, result, (resolvedResult) => {
          setData(resolvedResult.data);
          if (resolvedResult.canonicalSearch !== buildConnectedAccountsSearch(nextQuery)) {
            replaceQuery(resolvedResult.query);
          }
        });
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        runtime.applyError(requestId, () => {
          showToast(t("toastOAuthLoadFailed"), "error");
        });
      } finally {
        runtime.applyFinally(requestId, () => {
          if (loadAbortControllerRef.current === controller) {
            loadAbortControllerRef.current = null;
          }
          setLoading(false);
        });
      }
    },
    [nextRequestId, replaceQuery, runtime, showToast, t]
  );

  useEffect(() => {
    void refreshData(query);

    return () => {
      loadAbortControllerRef.current?.abort();
      loadAbortControllerRef.current = null;
    };
  }, [query, refreshData]);

  useEffect(() => {
    const visibleKeys = new Set(getSelectableConnectedAccountsActionKeys(data?.items ?? []));
    setSelectedActionKeys((current) => current.filter((entry) => visibleKeys.has(entry)));
  }, [data?.items]);

  const visibleItems = data?.items ?? [];
  const availableStatuses = data?.availableStatuses ?? [];
  const totalPages = data?.totalPages ?? 1;
  const currentPage = data?.page ?? query.page;

  const handleQueryChange = (value: string) => {
    replaceQuery({ ...query, q: value, page: 1 });
  };

  const handleStatusChange = (value: string) => {
    replaceQuery({ ...query, status: value, page: 1 });
  };

  const handlePageSizeChange = (value: number) => {
    replaceQuery({ ...query, pageSize: value, page: 1 });
  };

  const handlePageChange = (page: number) => {
    replaceQuery({ ...query, page });
  };

  const handleToggleVisible = (checked: boolean) => {
    setSelectedActionKeys(checked ? getSelectableConnectedAccountsActionKeys(visibleItems) : []);
  };

  const handleToggleRow = (actionKey: string, checked: boolean) => {
    setSelectedActionKeys((current) => updateSelection(current, actionKey, checked));
  };

  const handleRowAction = async (
    item: OAuthListItem,
    action: "enable" | "disable" | "disconnect"
  ) => {
    const requestId = nextRequestId();
    setLoadingActionKey(item.actionKey);
    try {
      const result = await submitConnectedAccountRowAction({
        query,
        accountId: item.id,
        action,
      });
      runtime.applyRowActionSuccess(requestId, result, (resolvedResult) => {
        setData(resolvedResult.data);
        if (resolvedResult.canonicalSearch !== buildConnectedAccountsSearch(query)) {
          replaceQuery(resolvedResult.query);
        }
      });
    } catch {
      runtime.applyError(requestId, () => {
        showToast(t("errorUpdateAccountFailed"), "error");
      });
    } finally {
      runtime.applyFinally(requestId, () => {
        setLoadingActionKey(null);
      });
    }
  };

  const handleBulkAction = async (action: "enable" | "disable" | "disconnect") => {
    if (selectedActionKeys.length === 0) {
      return;
    }

    const requestId = nextRequestId();
    setLoadingBulkAction(action);
    try {
      const result = await submitConnectedAccountsBulkAction({
        query,
        action,
        actionKeys: selectedActionKeys,
      });

      runtime.applyBulkActionSuccess(requestId, result, (resolvedResult) => {
        setData(resolvedResult.refreshed.data);
        setSelectedActionKeys([]);

        if (resolvedResult.refreshed.canonicalSearch !== buildConnectedAccountsSearch(query)) {
          replaceQuery(resolvedResult.refreshed.query);
        }

        if ((resolvedResult.summary?.failureCount ?? 0) > 0) {
          showToast(t("connectedAccountsBulkPartial"), "info");
        } else {
          showToast(t("connectedAccountsBulkSuccess"), "success");
        }
      });
    } catch {
      runtime.applyError(requestId, () => {
        showToast(t("connectedAccountsBulkFailed"), "error");
      });
    } finally {
      runtime.applyFinally(requestId, () => {
        setLoadingBulkAction(null);
      });
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("connectedAccountsTitle")}</CardTitle>
          <p className="text-sm text-[var(--text-muted)]">{t("connectedAccountsDescription")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConnectedAccountsToolbar
            query={query.q}
            status={query.status}
            pageSize={query.pageSize}
            page={currentPage}
            total={data?.total ?? 0}
            availableStatuses={availableStatuses}
            onQueryChange={handleQueryChange}
            onStatusChange={handleStatusChange}
            onPageSizeChange={handlePageSizeChange}
          />

          <ConnectedAccountsBulkBar
            selectedCount={selectedActionKeys.length}
            loadingAction={loadingBulkAction}
            onClear={() => setSelectedActionKeys([])}
            onSubmit={handleBulkAction}
          />

          {loading ? (
            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-6 text-sm text-[var(--text-muted)]">
              {tc("loading")}
            </div>
          ) : (
            <>
              <ConnectedAccountsTable
                items={visibleItems}
                selectedActionKeys={selectedActionKeys}
                loadingActionKey={loadingActionKey}
                onToggleVisible={handleToggleVisible}
                onToggleRow={handleToggleRow}
                onRowAction={handleRowAction}
              />

              <ConnectedAccountsPagination
                page={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default ConnectedAccountsPage;
