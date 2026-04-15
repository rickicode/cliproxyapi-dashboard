"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

interface ConnectedAccountsBulkBarProps {
  selectedCount: number;
  loadingAction: string | null;
  onClear: () => void;
  onSubmit: (action: "enable" | "disable" | "disconnect") => void;
}

export function ConnectedAccountsBulkBar({
  selectedCount,
  loadingAction,
  onClear,
  onSubmit,
}: ConnectedAccountsBulkBarProps) {
  const t = useTranslations("providers");

  if (selectedCount === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] px-4 py-3">
      <div className="text-sm text-[var(--text-secondary)]">
        {t("connectedAccountsSelectedCount", { count: selectedCount })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          disabled={loadingAction !== null}
          onClick={() => onSubmit("enable")}
        >
          {loadingAction === "enable" ? "..." : t("enableButton")}
        </Button>
        <Button
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          disabled={loadingAction !== null}
          onClick={() => onSubmit("disable")}
        >
          {loadingAction === "disable" ? "..." : t("disableButton")}
        </Button>
        <Button
          variant="danger"
          className="px-2.5 py-1 text-xs"
          disabled={loadingAction !== null}
          onClick={() => onSubmit("disconnect")}
        >
          {loadingAction === "disconnect" ? "..." : t("disconnectButton")}
        </Button>
        <Button
          variant="ghost"
          className="px-2.5 py-1 text-xs"
          disabled={loadingAction !== null}
          onClick={onClear}
        >
          {t("connectedAccountsClearSelection")}
        </Button>
      </div>
    </div>
  );
}
