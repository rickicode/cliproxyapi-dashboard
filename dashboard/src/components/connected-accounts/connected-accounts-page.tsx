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
import {
  buildConnectedAccountsSearch,
  createConnectedAccountsRuntime,
  loadConnectedAccountsPageData,
  parseConnectedAccountsQuery,
  refreshConnectedAccountsPageData,
  shouldRenderConnectedAccountsResults,
  submitConnectedAccountRowAction,
  type ConnectedAccountsQueryState,
  type ConnectedAccountsStateSnapshot,
} from "@/components/connected-accounts/connected-accounts-page-logic";

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

export function ConnectedAccountsPage({
  initialState,
}: {
  initialState?: Partial<ConnectedAccountsStateSnapshot>;
} = {}) {
  const t = useTranslations("providers");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const query = useMemo(() => parseConnectedAccountsQuery(searchParams), [searchParams]);
  const [data, setData] = useState<OAuthListResponseData | null>(initialState?.data ?? null);
  const [loading, setLoading] = useState(initialState?.loading ?? true);
  const [loadError, setLoadError] = useState<string | null>(initialState?.loadError ?? null);
  const [selectedActionKeys, setSelectedActionKeys] = useState<string[]>(initialState?.selectedActionKeys ?? []);
  const [loadingActionKey, setLoadingActionKey] = useState<string | null>(initialState?.loadingActionKey ?? null);
  const [loadingBulkAction, setLoadingBulkAction] = useState<string | null>(initialState?.loadingBulkAction ?? null);
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
      await refreshConnectedAccountsPageData({
        nextQuery,
        requestId,
        runtime,
        loadAbortControllerRef,
        replaceQuery,
        setData,
        setLoadError,
        setLoading,
        showToast,
        loadFailedMessage: t("toastOAuthLoadFailed"),
      });
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
              {loadError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300"
                >
                  {loadError}
                </div>
              ) : null}

              {shouldRenderConnectedAccountsResults({ data, loadError }) ? (
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
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default ConnectedAccountsPage;
