"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { CurrentUserLike } from "@/components/providers/api-key-section";
import { OAuthCredentialList, type OAuthAccountWithOwnership } from "@/components/providers/oauth-credential-list";
import { API_ENDPOINTS } from "@/lib/api-endpoints";

interface OAuthPreviewResponse {
  data?: {
    items?: OAuthAccountWithOwnership[];
    total?: number;
  };
}

interface OAuthPreviewCardProps {
  currentUser: CurrentUserLike | null;
  onAccountCountChange: (count: number) => void;
}

export function OAuthPreviewCard({ currentUser, onAccountCountChange }: OAuthPreviewCardProps) {
  const t = useTranslations("providers");
  const [accounts, setAccounts] = useState<OAuthAccountWithOwnership[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPreview = useCallback(async () => {
    setLoading(true);

    try {
      const searchParams = new URLSearchParams({ preview: "true", page: "1", pageSize: "10" });
      const response = await fetch(`${API_ENDPOINTS.PROVIDERS.OAUTH}?${searchParams.toString()}`);

      if (!response.ok) {
        setAccounts([]);
        onAccountCountChange(0);
        setLoading(false);
        return;
      }

      const payload = (await response.json()) as OAuthPreviewResponse;
      const items = Array.isArray(payload.data?.items) ? payload.data.items : [];
      const total = typeof payload.data?.total === "number" ? payload.data.total : items.length;

      setAccounts(items);
      onAccountCountChange(total);
    } catch {
      setAccounts([]);
      onAccountCountChange(0);
    } finally {
      setLoading(false);
    }
  }, [onAccountCountChange]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadPreview();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadPreview]);

  return (
    <section className="space-y-3 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("connectedAccountsPreviewTitle")}</h2>
          <p className="text-xs text-[var(--text-muted)]">{t("connectedAccountsPreviewDescription")}</p>
        </div>

        <Link
          href="/dashboard/connected-accounts"
          className="glass-button-secondary inline-flex rounded-full border px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors duration-200"
        >
          {t("viewAllConnectedAccountsButton")}
        </Link>
      </div>

      <OAuthCredentialList
        accounts={accounts}
        loading={loading}
        currentUser={currentUser}
        togglingAccountId={null}
        claimingAccountName={null}
        onToggle={() => undefined}
        onDelete={() => undefined}
        onClaim={() => undefined}
        showHeader={false}
        description={t("connectedAccountsPreviewDescription")}
        emptyMessage={t("connectedAccountsPreviewEmpty")}
      />
    </section>
  );
}
