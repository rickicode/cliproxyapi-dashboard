"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import type { ModelFirstProviderSummary, QuotaMonitorMode, QuotaResponse } from "@/lib/model-first-monitoring";

export interface QuotaWindowCapacitySummary {
  id: string;
  label: string;
  capacity: number;
  resetTime: string | null;
  isShortTerm: boolean;
}

export interface QuotaProviderSummary {
  provider: string;
  monitorMode: QuotaMonitorMode;
  totalAccounts: number;
  activeAccounts: number;
  healthyAccounts: number;
  errorAccounts: number;
  windowCapacities: QuotaWindowCapacitySummary[];
  modelFirstSummary?: ModelFirstProviderSummary;
  lowCapacity: boolean;
}

export interface QuotaSummaryResponse {
  providers: QuotaProviderSummary[];
  totals: {
    activeAccounts: number;
    providerCount: number;
    lowCapacityCount: number;
  };
  warnings: Array<{
    provider: string;
    count: number;
  }>;
  generatedAt?: string;
}

export const QUOTA_SWR_KEY = API_ENDPOINTS.QUOTA.BASE;
export const QUOTA_SUMMARY_SWR_KEY = `${API_ENDPOINTS.QUOTA.BASE}?view=summary`;
export const QUOTA_DETAIL_SWR_KEY = `${API_ENDPOINTS.QUOTA.BASE}?view=detail`;
const QUOTA_DEDUPING_INTERVAL = 30_000;

export async function quotaFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Quota request failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

interface UseQuotaDataOptions {
  enabled?: boolean;
  refreshInterval?: number;
}

export function buildBustUrl(swrKey: string) {
  const separator = swrKey.includes("?") ? "&" : "?";
  return `${swrKey}${separator}bust=${Date.now()}`;
}

function useQuotaSWR<T>(swrKey: string, options: UseQuotaDataOptions = {}) {
  const { enabled = true, refreshInterval } = options;

  const swr = useSWR<T>(enabled ? swrKey : null, quotaFetcher<T>, {
    refreshInterval,
    dedupingInterval: QUOTA_DEDUPING_INTERVAL,
    revalidateOnFocus: false,
  });

  const refresh = useCallback(
    async (bust = false) => {
      if (!enabled) return swr.data ?? null;

      if (bust) {
        const bustUrl = buildBustUrl(swrKey);
        return swr.mutate(quotaFetcher<T>(bustUrl), {
          revalidate: false,
          populateCache: true,
        });
      }

      return swr.mutate();
    },
    [enabled, swr, swrKey]
  );

  return {
    ...swr,
    refresh,
  };
}

export function useQuotaSummaryData(options: UseQuotaDataOptions = {}) {
  return useQuotaSWR<QuotaSummaryResponse>(QUOTA_SUMMARY_SWR_KEY, options);
}

export function useQuotaDetailData(options: UseQuotaDataOptions = {}) {
  return useQuotaSWR<QuotaResponse>(QUOTA_DETAIL_SWR_KEY, options);
}

export function useQuotaData(options: UseQuotaDataOptions = {}) {
  return useQuotaDetailData(options);
}
