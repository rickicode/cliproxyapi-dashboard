"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";

interface ConnectedAccountsToolbarProps {
  query: string;
  status: string;
  pageSize: number;
  page: number;
  total: number;
  availableStatuses: string[];
  onQueryChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onPageSizeChange: (value: number) => void;
}

export function ConnectedAccountsToolbar({
  query,
  status,
  pageSize,
  page,
  total,
  availableStatuses,
  onQueryChange,
  onStatusChange,
  onPageSizeChange,
}: ConnectedAccountsToolbarProps) {
  const t = useTranslations("providers");
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = total === 0 ? 0 : Math.min(total, start + pageSize - 1);

  return (
    <div className="space-y-3">
      <div className="text-xs text-[var(--text-muted)]">
        {total === 0
          ? t("connectedAccountsResultsSummaryEmpty")
          : t("connectedAccountsResultsSummary", { start, end, total })}
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_140px]">
        <Input
          name="connected-accounts-query"
          value={query}
          onChange={onQueryChange}
          placeholder={t("connectedAccountsSearchPlaceholder")}
        />

        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          <span>{t("connectedAccountsStatusLabel")}</span>
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value)}
            className="glass-input rounded-md px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none"
          >
            <option value="all">{t("connectedAccountsStatusAll")}</option>
            {availableStatuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          <span>{t("connectedAccountsPageSizeLabel")}</span>
          <select
            value={String(pageSize)}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="glass-input rounded-md px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none"
          >
            {[10, 25, 50, 100].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
