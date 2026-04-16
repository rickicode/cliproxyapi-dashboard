"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { HelpTooltip } from "@/components/ui/tooltip";
import { QuotaToolbar } from "@/components/quota/quota-toolbar";
import { useQuotaDetailData, useQuotaSummaryData } from "@/hooks/use-quota-data";
import {
  enrichModelFirstGroup,
  isModelFirstAccount,
  isModelFirstAccountQuotaUnverified,
  isModelFirstProviderQuotaUnverified,
  normalizeFraction,
  summarizeModelFirstProvider,
  type QuotaAccount,
  type ModelFirstProviderSummary,
} from "@/lib/model-first-monitoring";
import { formatRelativeTime } from "@/lib/format-relative-time";
import {
  buildQuotaSearch,
  DEFAULT_QUOTA_QUERY_STATE,
  parseQuotaQueryState,
  type QuotaQueryProvider,
  type QuotaQueryState,
  type QuotaQueryStatus,
} from "@/lib/quota/query-state";
import { getQuotaProviderLabel, normalizeQuotaProvider } from "@/lib/quota/provider";

const QuotaChart = dynamic(
  () => import("@/components/quota/quota-chart").then((mod) => ({ default: mod.QuotaChart })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-lg bg-[var(--surface-muted)]" /> }
);
import { QuotaDetails } from "@/components/quota/quota-details";
import { QuotaAlerts } from "@/components/quota/quota-alerts";

export const QUOTA_ACCOUNTS_PAGE_SIZE = 25;

type ProviderSummary = NonNullable<ReturnType<typeof useQuotaSummaryData>["data"]>["providers"][number];
type QuotaSummaryWarning = NonNullable<ReturnType<typeof useQuotaSummaryData>["data"]>["warnings"][number];

interface DerivedProviderSummary {
  provider: string;
  monitorMode: "window-based" | "model-first";
  totalAccounts: number;
  activeAccounts: number;
  healthyAccounts: number;
  errorAccounts: number;
  windowCapacities: Array<{ id: string; label: string; capacity: number; resetTime: string | null; isShortTerm: boolean }>;
  modelFirstSummary?: ModelFirstProviderSummary;
  lowCapacity: boolean;
}

export function matchesSelectedProvider(provider: string, selectedProvider: QuotaQueryProvider): boolean {
  if (selectedProvider === "all") return true;
  return normalizeQuotaProvider(provider) === normalizeQuotaProvider(selectedProvider);
}

function getQuotaAccountStatus(account: QuotaAccount): QuotaQueryStatus {
  if (!account.supported) return "disabled";
  if (account.error) return "error";

  if (isModelFirstAccount(account)) {
    const summary = summarizeModelFirstProvider([account]);
    if (isModelFirstProviderQuotaUnverified(summary)) return "warning";
    const accountSummary = account.groups ? account : { ...account, groups: [] };
    if (isModelFirstAccountQuotaUnverified(accountSummary)) return "warning";
  }

  const fractions = (account.groups ?? [])
    .map((group) => {
      const normalizedGroup = isModelFirstAccount(account)
        ? enrichModelFirstGroup(group)
        : group;
      return normalizeFraction(normalizedGroup.minRemainingFraction ?? normalizedGroup.remainingFraction);
    })
    .filter((value): value is number => value !== null);

  if (fractions.length > 0 && Math.min(...fractions) < 0.2) return "warning";

  return "active";
}

function matchesQuotaSearch(account: QuotaAccount, query: string) {
  if (!query) return true;
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const haystack = [account.email, account.provider, normalizeQuotaProvider(account.provider), account.auth_index]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

function matchesQuotaStatus(account: QuotaAccount, status: QuotaQueryStatus) {
  if (status === "all") return true;
  return getQuotaAccountStatus(account) === status;
}

export function filterQuotaAccounts(accounts: QuotaAccount[], query: QuotaQueryState) {
  return accounts.filter(
    (account) =>
      matchesSelectedProvider(account.provider, query.provider) &&
      matchesQuotaSearch(account, query.q) &&
      matchesQuotaStatus(account, query.status)
  );
}

function buildDerivedProviderSummary(provider: string, accounts: QuotaAccount[]): DerivedProviderSummary {
  const modelFirstOnly = accounts.length > 0 && accounts.every((account) => isModelFirstAccount(account));

  if (modelFirstOnly) {
    const modelFirstSummary = summarizeModelFirstProvider(accounts);
    return {
      provider,
      monitorMode: "model-first",
      totalAccounts: accounts.length,
      activeAccounts: accounts.filter((account) => account.supported && !account.error).length,
      healthyAccounts: accounts.filter((account) => account.supported && !account.error).length,
      errorAccounts: accounts.filter((account) => Boolean(account.error)).length,
      windowCapacities: [],
      modelFirstSummary,
      lowCapacity: !isModelFirstProviderQuotaUnverified(modelFirstSummary) && (modelFirstSummary.minRemainingFraction ?? 1) < 0.2,
    };
  }

  const windowGroups = new Map<string, { id: string; label: string; capacities: number[]; resetTime: string | null; isShortTerm: boolean }>();

  for (const account of accounts) {
    for (const group of account.groups ?? []) {
      const capacity = normalizeFraction(group.remainingFraction);
      if (capacity === null) continue;
      const existing = windowGroups.get(group.id) ?? {
        id: group.id,
        label: group.label,
        capacities: [],
        resetTime: group.resetTime,
        isShortTerm: /short|burst|minute|hour/i.test(group.id) || /short|burst|minute|hour/i.test(group.label),
      };
      existing.capacities.push(capacity);
      existing.resetTime = existing.resetTime ?? group.resetTime;
      windowGroups.set(group.id, existing);
    }
  }

  const windowCapacities = Array.from(windowGroups.values()).map((group) => ({
    id: group.id,
    label: group.label,
    capacity: Math.min(...group.capacities),
    resetTime: group.resetTime,
    isShortTerm: group.isShortTerm,
  }));

  return {
    provider,
    monitorMode: "window-based",
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((account) => account.supported && !account.error).length,
    healthyAccounts: accounts.filter((account) => account.supported && !account.error).length,
    errorAccounts: accounts.filter((account) => Boolean(account.error)).length,
    windowCapacities,
    lowCapacity: windowCapacities.some((window) => window.capacity < 0.2),
  };
}

export function buildQuotaPageViewModel({
  accounts,
  summaryWarnings,
  query,
}: {
  accounts: QuotaAccount[];
  summaryWarnings: QuotaSummaryWarning[];
  query: QuotaQueryState;
}) {
  const filteredAccounts = filterQuotaAccounts(accounts, query);
  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / QUOTA_ACCOUNTS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, query.page), totalPages);
  const pageStart = (currentPage - 1) * QUOTA_ACCOUNTS_PAGE_SIZE;
  const paginatedAccounts = filteredAccounts.slice(pageStart, pageStart + QUOTA_ACCOUNTS_PAGE_SIZE);
  const providerBuckets = new Map<string, QuotaAccount[]>();

  for (const account of filteredAccounts) {
    const canonicalProvider = normalizeQuotaProvider(account.provider);
    const bucket = providerBuckets.get(canonicalProvider) ?? [];
    bucket.push(account);
    providerBuckets.set(canonicalProvider, bucket);
  }

  const providerSummaries = Array.from(providerBuckets.entries())
    .map(([provider, providerAccounts]) => buildDerivedProviderSummary(provider, providerAccounts))
    .sort((left, right) => left.provider.localeCompare(right.provider));

  return {
    filteredAccounts,
    paginatedAccounts,
    providerSummaries,
    toolbarTotal: filteredAccounts.length,
    activeAccounts: filteredAccounts.filter((account) => account.supported && !account.error).length,
    lowCapacityCount: filteredAccounts.filter((account) => getQuotaAccountStatus(account) === "warning").length,
    modelFirstWarnings: summaryWarnings.filter((warning) => matchesSelectedProvider(warning.provider, query.provider)),
    currentPage,
    totalPages,
    hasAnyAccounts: accounts.length > 0,
  };
}

export function buildQuotaSummaryFallbackViewModel({
  providerSummaries,
  summaryWarnings,
  query,
}: {
  providerSummaries: ProviderSummary[];
  summaryWarnings: QuotaSummaryWarning[];
  query: QuotaQueryState;
}) {
  const filteredProviderSummaries = Array.from(
    providerSummaries
      .filter((summary) => matchesSelectedProvider(summary.provider, query.provider))
      .reduce<Map<string, ProviderSummary[]>>((buckets, summary) => {
        const canonicalProvider = normalizeQuotaProvider(summary.provider);
        const bucket = buckets.get(canonicalProvider) ?? [];
        bucket.push(summary);
        buckets.set(canonicalProvider, bucket);
        return buckets;
      }, new Map())
      .entries()
  )
    .map(([provider, summaries]) => {
      const mergedSummary = {
        ...summaries[0],
        provider,
        totalAccounts: summaries.reduce((sum, summary) => sum + summary.totalAccounts, 0),
        activeAccounts: summaries.reduce((sum, summary) => sum + summary.activeAccounts, 0),
        healthyAccounts: summaries.reduce((sum, summary) => sum + summary.healthyAccounts, 0),
        errorAccounts: summaries.reduce((sum, summary) => sum + summary.errorAccounts, 0),
        lowCapacity: summaries.some((summary) => summary.lowCapacity),
      } satisfies ProviderSummary;

      const allModelFirst = summaries.every((summary) => summary.monitorMode === "model-first" && summary.modelFirstSummary);

      if (allModelFirst) {
        return {
          ...mergedSummary,
          monitorMode: "model-first" as const,
          windowCapacities: [],
          modelFirstSummary: aggregateModelFirstSummaries(
            summaries.map((summary) => ({
              provider,
              modelFirstSummary: summary.modelFirstSummary,
            }))
          ) ?? undefined,
        } satisfies ProviderSummary;
      }

      const windowCapacities = Array.from(
        summaries
          .flatMap((summary) => summary.windowCapacities)
          .reduce<
            Map<string, { id: string; label: string; capacity: number; resetTime: string | null; isShortTerm: boolean }>
          >((windows, window) => {
            const existing = windows.get(window.id);

            if (!existing) {
              windows.set(window.id, { ...window });
              return windows;
            }

            windows.set(window.id, {
              ...existing,
              capacity: Math.min(existing.capacity, window.capacity),
              resetTime: existing.resetTime ?? window.resetTime,
              isShortTerm: existing.isShortTerm || window.isShortTerm,
            });
            return windows;
          }, new Map())
          .values()
      );

      return {
        ...mergedSummary,
        provider,
        monitorMode: "window-based" as const,
        windowCapacities,
        modelFirstSummary: undefined,
      } satisfies ProviderSummary;
    })
    .sort((left, right) => left.provider.localeCompare(right.provider));

  return {
    filteredAccounts: [] as QuotaAccount[],
    paginatedAccounts: [] as QuotaAccount[],
    providerSummaries: filteredProviderSummaries,
    toolbarTotal: filteredProviderSummaries.reduce((sum, summary) => sum + summary.totalAccounts, 0),
    activeAccounts: filteredProviderSummaries.reduce((sum, summary) => sum + summary.activeAccounts, 0),
    lowCapacityCount: filteredProviderSummaries.filter((summary) => summary.lowCapacity).length,
    modelFirstWarnings: summaryWarnings.filter((warning) => matchesSelectedProvider(warning.provider, query.provider)),
    currentPage: 1,
    totalPages: 1,
    hasAnyAccounts: filteredProviderSummaries.reduce((sum, summary) => sum + summary.totalAccounts, 0) > 0,
  };
}

export function buildQuotaToolbarQuery(query: QuotaQueryState, updates: Partial<Pick<QuotaQueryState, "q" | "provider" | "status">>) {
  return {
    ...query,
    ...updates,
    page: 1,
  };
}

export function clearQuotaToolbarQuery(_query: QuotaQueryState): QuotaQueryState {
  return { ...DEFAULT_QUOTA_QUERY_STATE };
}

function pickIso(values: Array<string | null | undefined>, mode: "min" | "max"): string | null {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) return null;

  const timestamp = mode === "min" ? Math.min(...timestamps) : Math.max(...timestamps);
  return new Date(timestamp).toISOString();
}

function aggregateModelFirstSummaries(
  summaries: Array<Pick<DerivedProviderSummary, "provider" | "modelFirstSummary">>
): ModelFirstProviderSummary | null {
  if (summaries.length === 0 || summaries.some((summary) => !summary.modelFirstSummary)) {
    return null;
  }

  const modelFirstSummaries = summaries.map((summary) => summary.modelFirstSummary!);
  const totalAccounts = modelFirstSummaries.reduce((sum, summary) => sum + summary.totalAccounts, 0);
  const minValues = modelFirstSummaries
    .map((summary) => summary.minRemainingFraction)
    .filter((value): value is number => value !== null);
  const p50Weighted = modelFirstSummaries.reduce(
    (sum, summary) => sum + (summary.p50RemainingFraction ?? 0) * summary.totalAccounts,
    0
  );

  return {
    totalAccounts,
    readyAccounts: modelFirstSummaries.reduce((sum, summary) => sum + summary.readyAccounts, 0),
    staleAccounts: modelFirstSummaries.reduce((sum, summary) => sum + summary.staleAccounts, 0),
    minRemainingFraction: minValues.length > 0 ? Math.min(...minValues) : null,
    p50RemainingFraction: totalAccounts > 0 ? p50Weighted / totalAccounts : null,
    nextWindowResetAt: pickIso(modelFirstSummaries.map((summary) => summary.nextWindowResetAt), "min"),
    fullWindowResetAt: pickIso(modelFirstSummaries.map((summary) => summary.fullWindowResetAt), "max"),
    nextRecoveryAt: pickIso(modelFirstSummaries.map((summary) => summary.nextRecoveryAt), "min"),
    groups: modelFirstSummaries.flatMap((summary, index) => {
      const provider = summaries[index]?.provider ?? "unknown";
      const prefix = summaries.length > 1 ? `${getQuotaProviderLabel(provider)} — ` : "";
      return summary.groups.map((group) => ({
        ...group,
        id: `${provider}:${group.id}`,
        label: `${prefix}${group.label}`,
      }));
    }),
  };
}

function calcOverallCapacity(
  summaries: Array<{
    healthyAccounts: number;
    monitorMode: "window-based" | "model-first";
    windowCapacities: Array<{ capacity: number; isShortTerm: boolean }>;
    modelFirstSummary?: ModelFirstProviderSummary;
  }>,
  noDataLabel: string,
  weightedLabel: string
): { value: number; label: string; provider: string } {
  if (summaries.length === 0) return { value: 0, label: noDataLabel, provider: "" };

  let weightedCapacity = 0;
  let weightedAccounts = 0;

  for (const summary of summaries) {
    if (summary.healthyAccounts === 0) {
      continue;
    }

    if (summary.monitorMode === "model-first" && summary.modelFirstSummary) {
      if (isModelFirstProviderQuotaUnverified(summary.modelFirstSummary)) {
        continue;
      }

      const providerCapacity =
        summary.modelFirstSummary.totalAccounts > 0
          ? summary.modelFirstSummary.readyAccounts / summary.modelFirstSummary.totalAccounts
          : 0;
      weightedCapacity += providerCapacity * summary.healthyAccounts;
      weightedAccounts += summary.healthyAccounts;
      continue;
    }

    const longTerm = summary.windowCapacities.filter((window) => !window.isShortTerm);
    const shortTerm = summary.windowCapacities.filter((window) => window.isShortTerm);
    const relevantWindows = longTerm.length > 0 ? longTerm : shortTerm;

    if (relevantWindows.length === 0) {
      continue;
    }

    const providerCapacity = Math.min(...relevantWindows.map((window) => window.capacity));
    weightedCapacity += providerCapacity * summary.healthyAccounts;
    weightedAccounts += summary.healthyAccounts;
  }

  if (weightedAccounts === 0) {
    return { value: 0, label: noDataLabel, provider: "" };
  }

  return {
    value: weightedCapacity / weightedAccounts,
    label: weightedLabel,
    provider: "all",
  };
}

export async function refreshAllQuotaData(
  refreshSummary: (bust?: boolean) => Promise<unknown>,
  refreshDetail: (bust?: boolean) => Promise<unknown>
) {
  return Promise.allSettled([refreshSummary(true), refreshDetail(true)]);
}

export default function QuotaPage() {
  const t = useTranslations("quota");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    data: quotaSummary,
    isLoading: summaryLoading,
    error: summaryError,
    refresh: refreshSummary,
  } = useQuotaSummaryData({ refreshInterval: 120_000 });
  const {
    data: quotaDetail,
    isLoading: detailLoading,
    error: detailError,
    refresh: refreshDetail,
  } = useQuotaDetailData({ refreshInterval: 120_000 });
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const query = useMemo(() => parseQuotaQueryState(searchParams), [searchParams]);

  const loading = summaryLoading;
  const replaceQuery = (nextQuery: QuotaQueryState) => {
    const nextSearch = buildQuotaSearch(nextQuery);
    router.replace(`${pathname}${nextSearch}`, { scroll: false });
  };

  const refreshAll = async () => {
    await refreshAllQuotaData(refreshSummary, refreshDetail);
  };

  const summaryFirst = Boolean(quotaSummary) && (detailLoading || !quotaDetail || Boolean(detailError));
  const {
    filteredAccounts,
    paginatedAccounts,
    providerSummaries,
    toolbarTotal,
    activeAccounts,
    lowCapacityCount,
    modelFirstWarnings,
    currentPage,
    totalPages,
    hasAnyAccounts,
  } = useMemo(() => {
    if (summaryFirst && quotaSummary) {
      return buildQuotaSummaryFallbackViewModel({
        providerSummaries: quotaSummary.providers,
        summaryWarnings: quotaSummary.warnings,
        query,
      });
    }

    return buildQuotaPageViewModel({
      accounts: quotaDetail?.accounts ?? [],
      summaryWarnings: quotaSummary?.warnings ?? [],
      query,
    });
  }, [summaryFirst, quotaDetail?.accounts, quotaSummary, quotaSummary?.warnings, query]);

  const replacePage = (page: number) => {
    replaceQuery({ ...query, page });
  };

  const normalizedSearch = buildQuotaSearch({ ...query, page: currentPage });
  const currentSearch = searchParams.toString();
  const expectedSearch = normalizedSearch.startsWith("?") ? normalizedSearch.slice(1) : normalizedSearch;

  useEffect(() => {
    if (currentSearch !== expectedSearch) {
      router.replace(`${pathname}${normalizedSearch}`, { scroll: false });
    }
  }, [currentSearch, expectedSearch, normalizedSearch, pathname, router]);

  const overallCapacity = calcOverallCapacity(providerSummaries, t("noData"), t("weightedCapacity"));
  const isModelFirstOnlyView =
    providerSummaries.length > 0 && providerSummaries.every((summary) => summary.monitorMode === "model-first");
  const modelFirstSummary = isModelFirstOnlyView ? aggregateModelFirstSummaries(providerSummaries) : null;
  const modelFirstQuotaUnverified = isModelFirstProviderQuotaUnverified(modelFirstSummary);

  const toggleCard = (accountId: string) => {
    setExpandedCards((previous) => ({ ...previous, [accountId]: !previous[accountId] }));
  };

  const freshSnapshotCount = modelFirstSummary
    ? Math.max(0, modelFirstSummary.totalAccounts - modelFirstSummary.staleAccounts)
    : 0;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{t("pageTitle")}</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {isModelFirstOnlyView ? t("modelFirstDescription") : t("pageDescription")}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Button onClick={() => void refreshAll()} disabled={summaryLoading || detailLoading} className="px-2.5 py-1 text-xs">
              {loading ? t("loadingText") : t("refreshButton")}
            </Button>
          </div>
        </div>
      </section>

      <QuotaToolbar
        query={query}
        total={toolbarTotal ?? filteredAccounts.length}
        onSearchChange={(value) => replaceQuery(buildQuotaToolbarQuery(query, { q: value }))}
        onProviderChange={(value) => replaceQuery(buildQuotaToolbarQuery(query, { provider: value }))}
        onStatusChange={(value) => replaceQuery(buildQuotaToolbarQuery(query, { status: value }))}
        onClear={() => replaceQuery(clearQuotaToolbarQuery(query))}
      />

      {loading && !quotaSummary ? (
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-6 text-center text-sm text-[var(--text-muted)]">
          {t("loadingText")}
        </div>
      ) : summaryError && !quotaSummary ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-center text-sm text-rose-700">
          {t("summaryLoadFailed")}
        </div>
      ) : (
        <>
          {modelFirstWarnings.length > 0 && (
            <section className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
              {modelFirstWarnings.map(({ provider, count }) => (
                <p key={provider}>
                  {t("modelFirstWarning", {
                    provider: getQuotaProviderLabel(provider),
                    count,
                  })}
                </p>
              ))}
            </section>
          )}

          <section className={`grid grid-cols-2 gap-2 ${isModelFirstOnlyView ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t("activeAccountsLabel")}</p>
              <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{activeAccounts}</p>
            </div>
            {isModelFirstOnlyView && modelFirstSummary ? (
              <>
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {modelFirstQuotaUnverified ? t("freshSnapshotsLabel") : t("readyAccountsLabel")}{" "}
                    <HelpTooltip
                      content={modelFirstQuotaUnverified ? t("freshSnapshotsTooltip") : t("readyAccountsTooltip")}
                    />
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">
                    {modelFirstQuotaUnverified ? freshSnapshotCount : modelFirstSummary.readyAccounts}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {t("staleSnapshotsLabel")}{" "}
                    <HelpTooltip content={t("staleSnapshotsTooltip")} />
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{modelFirstSummary.staleAccounts}</p>
                </div>
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {t("closestResetLabel")}{" "}
                    <HelpTooltip content={t("closestResetTooltip")} />
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">
                    {formatRelativeTime(modelFirstSummary.nextWindowResetAt, t)}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {t("modelFamiliesLabel")}{" "}
                    <HelpTooltip content={t("modelFamiliesTooltip")} />
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{modelFirstSummary.groups.length}</p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {t("overallCapacityLabel")}{" "}
                    <HelpTooltip content={t("overallCapacityTooltip")} />
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{Math.round(overallCapacity.value * 100)}%</p>
                </div>
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {t("lowCapacityLabel")}{" "}
                    <HelpTooltip content={t("lowCapacityTooltip")} />
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{lowCapacityCount}</p>
                </div>
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{t("providersLabel")}</p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{providerSummaries.length}</p>
                </div>
              </>
            )}
          </section>

          <QuotaChart
            overallCapacity={overallCapacity}
            providerSummaries={providerSummaries}
            modelFirstSummary={modelFirstSummary}
            modelFirstOnlyView={isModelFirstOnlyView}
          />

          <QuotaDetails
            filteredAccounts={paginatedAccounts}
            hasAnyAccounts={hasAnyAccounts}
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={replacePage}
            expandedCards={expandedCards}
            onToggleCard={toggleCard}
            loading={detailLoading}
            error={Boolean(detailError)}
            modelFirstOnlyView={isModelFirstOnlyView}
          />
        </>
      )}

      <QuotaAlerts />
    </div>
  );
}
