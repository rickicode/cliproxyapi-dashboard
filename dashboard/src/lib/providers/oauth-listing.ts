import type { OAuthAccountWithOwnership } from "@/lib/providers/management-api";

export interface OAuthListItem extends OAuthAccountWithOwnership {
  rowKey: string;
  actionKey: string;
  canToggle: boolean;
  canDelete: boolean;
  canClaim: boolean;
}

export interface OAuthListQuery {
  q: string;
  status: string;
  page: number;
  pageSize: number;
  preview: boolean;
}

export const DEFAULT_OAUTH_LIST_QUERY: OAuthListQuery = {
  q: "",
  status: "all",
  page: 1,
  pageSize: 50,
  preview: false,
};

export interface OAuthListResponseData {
  items: OAuthListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  availableStatuses: string[];
}

function parseStatusSearchText(statusMessage: string | null): string {
  if (!statusMessage) {
    return "";
  }

  try {
    const parsed = JSON.parse(statusMessage) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? statusMessage;
  } catch {
    return statusMessage;
  }
}

export function buildOAuthListResponse(rows: OAuthListItem[], query: OAuthListQuery): OAuthListResponseData {
  const normalizedQuery = query.q.trim().toLowerCase();
  const availableStatuses = Array.from(new Set(rows.map((row) => row.status))).sort();

  const filteredRows = rows.filter((row) => {
    if (query.status !== "all" && row.status !== query.status) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    return [
      row.accountName,
      row.accountEmail ?? "",
      row.provider,
      row.status,
      parseStatusSearchText(row.statusMessage),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  const pageSize = query.preview ? 10 : query.pageSize;
  const total = filteredRows.length;
  const totalPages = query.preview ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const page = query.preview ? 1 : Math.min(Math.max(1, query.page), totalPages);
  const startIndex = query.preview ? 0 : (page - 1) * pageSize;

  return {
    items: filteredRows.slice(startIndex, startIndex + pageSize),
    page,
    pageSize,
    total,
    totalPages,
    availableStatuses,
  };
}
