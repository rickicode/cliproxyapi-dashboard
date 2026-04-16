"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { CurrentUserLike } from "@/components/providers/api-key-section";
import { OAuthCredentialList, type OAuthAccountWithOwnership } from "@/components/providers/oauth-credential-list";
import { useToast } from "@/components/ui/toast";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { extractApiError } from "@/lib/utils";

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

interface OAuthPreviewState {
  accounts: OAuthAccountWithOwnership[];
  total: number;
}

type ProviderTranslator = (key: string, values?: Record<string, string | number>) => string;

type OAuthPreviewLoadResult =
  | { ok: true; state: OAuthPreviewState }
  | { ok: false; errorMessage: string };

type OAuthClaimResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

export async function fetchOAuthPreview(
  fetchImpl: typeof fetch,
  t: ProviderTranslator
): Promise<OAuthPreviewLoadResult> {
  try {
    const searchParams = new URLSearchParams({ preview: "true", page: "1", pageSize: "10" });
    const response = await fetchImpl(`${API_ENDPOINTS.PROVIDERS.OAUTH}?${searchParams.toString()}`);

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));

      return {
        ok: false,
        errorMessage: extractApiError(data, t("toastOAuthLoadFailed")),
      };
    }

    const payload = (await response.json()) as OAuthPreviewResponse;
    const items = Array.isArray(payload.data?.items) ? payload.data.items : [];
    const total = typeof payload.data?.total === "number" ? payload.data.total : items.length;

    return {
      ok: true,
      state: {
        accounts: items,
        total,
      },
    };
  } catch {
    return {
      ok: false,
      errorMessage: t("toastOAuthLoadFailed"),
    };
  }
}

export async function claimOAuthPreviewAccount(
  accountName: string,
  fetchImpl: typeof fetch,
  t: ProviderTranslator
): Promise<OAuthClaimResult> {
  try {
    const response = await fetchImpl(API_ENDPOINTS.PROVIDERS.OAUTH_CLAIM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountName }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));

      return {
        ok: false,
        errorMessage: extractApiError(data, t("toastOAuthClaimFailed")),
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      errorMessage: t("toastOAuthClaimFailed"),
    };
  }
}

export function getNextOAuthPreviewState(
  previousState: OAuthPreviewState,
  result: OAuthPreviewLoadResult
): OAuthPreviewState {
  return result.ok ? result.state : previousState;
}

export function OAuthPreviewCard({ currentUser, onAccountCountChange }: OAuthPreviewCardProps) {
  const t = useTranslations("providers");
  const { showToast } = useToast();
  const [previewState, setPreviewState] = useState<OAuthPreviewState>({ accounts: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [claimingAccountName, setClaimingAccountName] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);

    try {
      const result = await fetchOAuthPreview(fetch, t);

      if (!result.ok) {
        showToast(result.errorMessage, "error");
        return false;
      }

      const nextState = result.state;
      setPreviewState(nextState);
      onAccountCountChange(nextState.total);

      return true;
    } finally {
      setLoading(false);
    }
  }, [onAccountCountChange, showToast, t]);

  const handleClaim = useCallback(
    async (accountName: string) => {
      setClaimingAccountName(accountName);

      try {
        const claimResult = await claimOAuthPreviewAccount(accountName, fetch, t);

        if (!claimResult.ok) {
          showToast(claimResult.errorMessage, "error");
          return;
        }

        await loadPreview();
      } finally {
        setClaimingAccountName(null);
      }
    },
    [loadPreview, showToast, t]
  );

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
        accounts={previewState.accounts}
        loading={loading}
        currentUser={currentUser}
        togglingAccountId={null}
        claimingAccountName={claimingAccountName}
        onToggle={() => undefined}
        onDelete={() => undefined}
        onClaim={(accountName) => {
          void handleClaim(accountName);
        }}
        showHeader={false}
        description={t("connectedAccountsPreviewDescription")}
        emptyMessage={t("connectedAccountsPreviewEmpty")}
      />
    </section>
  );
}
