"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { HelpTooltip } from "@/components/ui/tooltip";
import { useQuotaDetailData, useQuotaSummaryData } from "@/hooks/use-quota-data";
import {
  isModelFirstProviderQuotaUnverified,
  type ModelFirstProviderSummary,
} from "@/lib/model-first-monitoring";
import { formatRelativeTime } from "@/lib/format-relative-time";

const QuotaChart = dynamic(
  () => import("@/components/quota/quota-chart").then((mod) => ({ default: mod.QuotaChart })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-lg bg-[var(--surface-muted)]" /> }
);
import { QuotaDetails } from "@/components/quota/quota-details";
import { QuotaAlerts } from "@/components/quota/quota-alerts";

const PROVIDERS = {
  ALL: "all",
  ANTIGRAVITY: "antigravity",
  CLAUDE: "claude",
  CODEX: "codex",
  COPILOT: "github-copilot",
  KIMI: "kimi",
} as const;

type ProviderType = (typeof PROVIDERS)[keyof typeof PROVIDERS];

type ProviderSummary = NonNullable<ReturnType<typeof useQuotaSummaryData>["data"]>["providers"][number];

export function matchesSelectedProvider(provider: string, selectedProvider: ProviderType): boolean {
  if (selectedProvider === PROVIDERS.ALL) return true;
  if (selectedProvider === PROVIDERS.COPILOT) {
    return provider === "github" || provider === "github-copilot" || provider === "copilot";
  }
  return provider === selectedProvider;
}

function capitalizeProvider(provider: string): string {
  if (provider === "github-copilot") return "Copilot";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function pickIso(values: Array<string | null | undefined>, mode: "min" | "max"): string | null {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) return null;

  const timestamp = mode === "min" ? Math.min(...timestamps) : Math.max(...timestamps);
  return new Date(timestamp).toISOString();
}

function aggregateModelFirstSummaries(summaries: ProviderSummary[]): ModelFirstProviderSummary | null {
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
      const prefix = summaries.length > 1 ? `${capitalizeProvider(provider)} — ` : "";
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
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>(PROVIDERS.ALL);
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});

  const loading = summaryLoading;
  const refreshAll = async () => {
    await refreshAllQuotaData(refreshSummary, refreshDetail);
  };

  const filteredAccounts =
    quotaDetail?.accounts.filter((account) => {
      return matchesSelectedProvider(account.provider, selectedProvider);
    }) ?? [];

  const providerSummaries = quotaSummary?.providers ?? [];
  const selectedProviderSummaries = providerSummaries.filter((summary) =>
    matchesSelectedProvider(summary.provider, selectedProvider)
  );
  const activeAccounts = selectedProviderSummaries.reduce((sum, summary) => sum + summary.activeAccounts, 0);

  const overallCapacity = calcOverallCapacity(selectedProviderSummaries, t("noData"), t("weightedCapacity"));
  const isModelFirstOnlyView =
    selectedProviderSummaries.length > 0 &&
    selectedProviderSummaries.every((summary) => summary.monitorMode === "model-first");
  const modelFirstSummary = isModelFirstOnlyView ? aggregateModelFirstSummaries(selectedProviderSummaries) : null;
  const modelFirstQuotaUnverified = isModelFirstProviderQuotaUnverified(modelFirstSummary);
  const modelFirstWarnings = (quotaSummary?.warnings ?? []).filter((warning) =>
    matchesSelectedProvider(warning.provider, selectedProvider)
  );

  const lowCapacityCount = selectedProviderSummaries.filter((summary) => summary.lowCapacity).length;

  const providerFilters = [
    { key: PROVIDERS.ALL, label: t("filterAll") },
    { key: PROVIDERS.ANTIGRAVITY, label: t("filterAntigravity") },
    { key: PROVIDERS.CLAUDE, label: t("filterClaude") },
    { key: PROVIDERS.CODEX, label: t("filterCodex") },
    { key: PROVIDERS.COPILOT, label: t("filterCopilot") },
    { key: PROVIDERS.KIMI, label: t("filterKimi") },
  ];

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
            <div className="flex flex-wrap gap-1">
              {providerFilters.map((filter) => (
                <Button
                  key={filter.key}
                  variant={selectedProvider === filter.key ? "secondary" : "ghost"}
                  onClick={() => {
                    setSelectedProvider(filter.key);
                    if (filter.key !== PROVIDERS.ALL) {
                      setTimeout(() => {
                        document
                          .getElementById("quota-accounts")
                          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                      }, 50);
                    }
                  }}
                  className="px-2.5 py-1 text-xs"
                >
                  {filter.label}
                </Button>
              ))}
            </div>
            <Button onClick={() => void refreshAll()} disabled={summaryLoading || detailLoading} className="px-2.5 py-1 text-xs">
              {loading ? t("loadingText") : t("refreshButton")}
            </Button>
          </div>
        </div>
      </section>

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
                    provider: provider.charAt(0).toUpperCase() + provider.slice(1),
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
                  <p className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{selectedProviderSummaries.length}</p>
                </div>
              </>
            )}
          </section>

          <QuotaChart
            overallCapacity={overallCapacity}
            providerSummaries={selectedProviderSummaries}
            modelFirstSummary={modelFirstSummary}
            modelFirstOnlyView={isModelFirstOnlyView}
          />

          <QuotaDetails
            filteredAccounts={filteredAccounts}
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
