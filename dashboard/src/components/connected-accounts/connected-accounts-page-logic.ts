import { API_ENDPOINTS } from "@/lib/api-endpoints";
import type { OAuthListResponseData } from "@/lib/providers/oauth-listing";

export interface ConnectedAccountsQueryState {
  q: string;
  status: string;
  page: number;
  pageSize: number;
}

interface ConnectedAccountsEnvelope {
  data?: OAuthListResponseData;
}

export interface ConnectedAccountsStateSnapshot {
  data: OAuthListResponseData | null;
  loading: boolean;
  loadError: string | null;
  selectedActionKeys: string[];
  loadingActionKey: string | null;
  loadingBulkAction: string | null;
}

interface ReadonlyURLSearchParamsLike {
  get(name: string): string | null;
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

export function parseConnectedAccountsQuery(
  searchParams: URLSearchParams | ReadonlyURLSearchParamsLike
): ConnectedAccountsQueryState {
  return {
    q: searchParams.get("q") ?? DEFAULT_QUERY.q,
    status: searchParams.get("status") ?? DEFAULT_QUERY.status,
    page: parsePositiveInteger(searchParams.get("page"), DEFAULT_QUERY.page),
    pageSize: parsePositiveInteger(searchParams.get("pageSize"), DEFAULT_QUERY.pageSize),
  };
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
  applyBulkActionSuccess: <TResult>(
    requestId: number,
    result: TResult,
    handler: (result: TResult) => void
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

export function shouldRenderConnectedAccountsResults({
  data,
  loadError,
}: {
  data: OAuthListResponseData | null;
  loadError: string | null;
}) {
  return !(loadError && data === null);
}

export async function refreshConnectedAccountsPageData({
  nextQuery,
  requestId,
  runtime,
  loadAbortControllerRef,
  replaceQuery,
  setData,
  setLoadError,
  setLoading,
  showToast,
  loadFailedMessage,
  loadData = loadConnectedAccountsPageData,
}: {
  nextQuery: ConnectedAccountsQueryState;
  requestId: number;
  runtime: ConnectedAccountsRuntime;
  loadAbortControllerRef: { current: AbortController | null };
  replaceQuery: (nextQuery: ConnectedAccountsQueryState) => void;
  setData: (data: OAuthListResponseData) => void;
  setLoadError: (message: string | null) => void;
  setLoading: (loading: boolean) => void;
  showToast: (message: string, type: "success" | "error" | "info") => void;
  loadFailedMessage: string;
  loadData?: typeof loadConnectedAccountsPageData;
}) {
  loadAbortControllerRef.current?.abort();
  const controller = new AbortController();
  loadAbortControllerRef.current = controller;
  setLoading(true);
  setLoadError(null);

  try {
    const result = await loadData({ ...nextQuery, signal: controller.signal });
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
      setLoadError(loadFailedMessage);
      showToast(loadFailedMessage, "error");
    });
  } finally {
    runtime.applyFinally(requestId, () => {
      if (loadAbortControllerRef.current === controller) {
        loadAbortControllerRef.current = null;
      }
      setLoading(false);
    });
  }
}
