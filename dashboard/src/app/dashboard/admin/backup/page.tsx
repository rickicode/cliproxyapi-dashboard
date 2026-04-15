"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/hooks/use-auth";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { extractApiError } from "@/lib/utils";

type BackupMode = "settings" | "provider-credentials";

interface SettingsSummary {
  replacedDomains: string[];
  missingUsernames: string[];
}

const SETTINGS_DOMAIN_KEYS = ["systemSettings", "modelPreferences", "agentModelOverrides"] as const;
type SettingsDomainKey = (typeof SETTINGS_DOMAIN_KEYS)[number];

interface CredentialsSummary {
  providerKeys: { created: number; updated: number; skipped: number; failed: number };
  providerOAuth: { created: number; updated: number; skipped: number; failed: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeBackupType(type: unknown): string | null {
  if (type === "settings") return "settings";
  if (type === "providerCredentials") return "providerCredentials";
  if (type === "provider-credentials") return "providerCredentials";
  return null;
}

function normalizeBackupPayload(parsed: unknown): Record<string, unknown> | null {
  if (!isRecord(parsed)) return null;
  const normalizedType = normalizeBackupType(parsed.type);
  if (!normalizedType) return null;

  return {
    ...parsed,
    type: normalizedType,
  };
}

function normalizeCredentialsSummary(summary: unknown): CredentialsSummary {
  const empty = {
    providerKeys: { created: 0, updated: 0, skipped: 0, failed: 0 },
    providerOAuth: { created: 0, updated: 0, skipped: 0, failed: 0 },
  };

  if (!isRecord(summary)) return empty;

  const readLane = (value: unknown) => {
    if (!isRecord(value)) return { created: 0, updated: 0, skipped: 0, failed: 0 };

    return {
      created: getNumber(value.created),
      updated: getNumber(value.updated),
      skipped: getNumber(value.skipped),
      failed: getNumber(value.failed),
    };
  };

  return {
    providerKeys: readLane(summary.providerKeys),
    providerOAuth: readLane(summary.providerOAuth),
  };
}

function normalizeSettingsSummary(summary: unknown, t: ReturnType<typeof useTranslations>): SettingsSummary {
  if (!isRecord(summary)) {
    return { replacedDomains: [], missingUsernames: [] };
  }

  const replacedDomains = Array.isArray(summary.replacedDomains)
    ? summary.replacedDomains
        .filter((value): value is SettingsDomainKey =>
          typeof value === "string" && SETTINGS_DOMAIN_KEYS.includes(value as SettingsDomainKey)
        )
        .map((key) => t(`settingsDomain.${key}`))
    : [];

  return {
    replacedDomains,
    missingUsernames: [],
  };
}

export default function AdminBackupPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const { user, isLoading: authLoading } = useAuth();
  const t = useTranslations("backupRestore");
  const tc = useTranslations("common");

  const [settingsFile, setSettingsFile] = useState<File | null>(null);
  const [credentialsFile, setCredentialsFile] = useState<File | null>(null);

  const [downloadingSettings, setDownloadingSettings] = useState(false);
  const [downloadingCredentials, setDownloadingCredentials] = useState(false);
  const [restoringSettings, setRestoringSettings] = useState(false);
  const [restoringCredentials, setRestoringCredentials] = useState(false);
  const [showSettingsConfirm, setShowSettingsConfirm] = useState(false);

  const [settingsSummary, setSettingsSummary] = useState<SettingsSummary | null>(null);
  const [credentialsSummary, setCredentialsSummary] = useState<CredentialsSummary | null>(null);

  const anyBusy = downloadingSettings || downloadingCredentials || restoringSettings || restoringCredentials;

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      router.push("/login");
      return;
    }

    if (!user.isAdmin) {
      showToast(t("toastAdminRequired"), "error");
      router.push("/dashboard");
    }
  }, [authLoading, router, showToast, t, user]);

  const settingsFilename = useMemo(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `cliproxyapi-settings-backup-${stamp}.json`;
  }, []);

  const credentialsFilename = useMemo(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `cliproxyapi-provider-credentials-backup-${stamp}.json`;
  }, []);

  const handleAuthError = (status: number) => {
    if (status === 401) {
      router.push("/login");
      return true;
    }
    if (status === 403) {
      showToast(t("toastAdminRequired"), "error");
      router.push("/dashboard");
      return true;
    }
    return false;
  };

  const getBackupUrls = (mode: BackupMode): string[] => {
    if (mode === "settings") {
      return [
        `${API_ENDPOINTS.ADMIN.BACKUP}?mode=settings`,
        `${API_ENDPOINTS.ADMIN.BACKUP}?type=settings`,
      ];
    }

    return [
      `${API_ENDPOINTS.ADMIN.BACKUP}?mode=provider-credentials`,
      `${API_ENDPOINTS.ADMIN.BACKUP}?type=providerCredentials`,
    ];
  };

  const downloadBackup = async (mode: BackupMode) => {
    if (mode === "settings") {
      setDownloadingSettings(true);
    } else {
      setDownloadingCredentials(true);
    }

    try {
      const urls = getBackupUrls(mode);
      let response: Response | null = null;

      for (const url of urls) {
        const candidate = await fetch(url);
        if (handleAuthError(candidate.status)) {
          return;
        }

        if (candidate.ok) {
          response = candidate;
          break;
        }

        if (candidate.status !== 400 && candidate.status !== 404) {
          response = candidate;
          break;
        }
      }

      if (!response || !response.ok) {
        const data = response ? await response.json().catch(() => null) : null;
        showToast(extractApiError(data, t("toastBackupDownloadFailed")), "error");
        return;
      }

      const body = (await response.json()) as { backup?: unknown; data?: { backup?: unknown } };
      const backup = body.backup ?? body.data?.backup;

      if (!backup) {
        showToast(t("toastBackupDownloadFailed"), "error");
        return;
      }

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = mode === "settings" ? settingsFilename : credentialsFilename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(blobUrl);

      showToast(t("toastBackupDownloadSuccess"), "success");
    } catch {
      showToast(t("toastNetworkError"), "error");
    } finally {
      setDownloadingSettings(false);
      setDownloadingCredentials(false);
    }
  };

  const parseBackupFile = async (file: File, expectedMode: BackupMode): Promise<Record<string, unknown> | null> => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const normalized = normalizeBackupPayload(parsed);

      if (!normalized) {
        showToast(t("toastInvalidBackupJson"), "error");
        return null;
      }

      if (expectedMode === "settings" && normalized.type !== "settings") {
        showToast(t("toastWrongBackupTypeSettings"), "error");
        return null;
      }

      if (expectedMode === "provider-credentials" && normalized.type !== "providerCredentials") {
        showToast(t("toastWrongBackupTypeCredentials"), "error");
        return null;
      }

      return normalized;
    } catch {
      showToast(t("toastInvalidBackupJson"), "error");
      return null;
    }
  };

  const executeRestore = async (mode: BackupMode) => {
    const selectedFile = mode === "settings" ? settingsFile : credentialsFile;
    if (!selectedFile) {
      showToast(
        mode === "settings" ? t("toastSelectSettingsFile") : t("toastSelectCredentialsFile"),
        "error"
      );
      return;
    }

    const payload = await parseBackupFile(selectedFile, mode);
    if (!payload) return;

    if (mode === "settings") {
      setRestoringSettings(true);
      setSettingsSummary(null);
    } else {
      setRestoringCredentials(true);
      setCredentialsSummary(null);
    }

    try {
      const response = await fetch(API_ENDPOINTS.ADMIN.RESTORE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (handleAuthError(response.status)) {
        return;
      }

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const details = isRecord(data) && isRecord(data.error) && isRecord(data.error.details)
          ? data.error.details
          : null;

        if (mode === "settings" && details && Array.isArray(details.missingUsernames)) {
          const missingUsernames = details.missingUsernames.filter(
            (item): item is string => typeof item === "string"
          );
          setSettingsSummary({ replacedDomains: [], missingUsernames });
        }

        showToast(extractApiError(data, t("toastRestoreFailed")), "error");
        return;
      }

      const result = isRecord(data) && isRecord(data.result)
        ? data.result
        : isRecord(data) && isRecord(data.data) && isRecord(data.data.result)
          ? data.data.result
          : null;

      if (mode === "settings") {
        const summary = normalizeSettingsSummary(result && isRecord(result.summary) ? result.summary : null, t);
        setSettingsSummary(summary);
        showToast(t("toastSettingsRestoreSuccess"), "success");
      } else {
        const summary = normalizeCredentialsSummary(result && isRecord(result.summary) ? result.summary : null);
        setCredentialsSummary(summary);
        showToast(t("toastCredentialsRestoreSuccess"), "success");
      }
    } catch {
      showToast(t("toastNetworkError"), "error");
    } finally {
      if (mode === "settings") {
        setRestoringSettings(false);
      } else {
        setRestoringCredentials(false);
      }
    }
  };

  if (authLoading || !user?.isAdmin) {
    return (
      <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-6 text-sm text-[var(--text-muted)]">
        {tc("loading")}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="admin-backup-page">
      <Breadcrumbs
        items={[
          { label: tc("dashboard"), href: "/dashboard" },
          { label: tc("admin") },
          { label: t("breadcrumbLabel") },
        ]}
      />

      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]" data-testid="backup-title">
            {t("pageTitle")}
          </h1>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t("pageDescription")}</p>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("downloadSettingsTitle")}</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t("downloadSettingsDescription")}</p>
          <div className="mt-4">
            <Button
              onClick={() => void downloadBackup("settings")}
              disabled={anyBusy}
              data-testid="download-settings-backup"
            >
              {downloadingSettings ? t("downloadingButton") : t("downloadSettingsButton")}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("restoreSettingsTitle")}</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t("restoreSettingsDescription")}</p>
          <div className="mt-4 space-y-3">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => setSettingsFile(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-[var(--text-secondary)] file:mr-3 file:rounded-full file:border file:border-[var(--surface-border)] file:bg-[var(--surface-muted)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--text-primary)]"
              disabled={anyBusy}
              data-testid="settings-restore-file"
            />
            <Button
              onClick={() => {
                if (!settingsFile) {
                  showToast(t("toastSelectSettingsFile"), "error");
                  return;
                }
                setShowSettingsConfirm(true);
              }}
              disabled={anyBusy}
              variant="danger"
              data-testid="open-settings-restore-confirm"
            >
              {restoringSettings ? t("restoringButton") : t("restoreSettingsButton")}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("downloadCredentialsTitle")}</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t("downloadCredentialsDescription")}</p>
          <div className="mt-4">
            <Button
              onClick={() => void downloadBackup("provider-credentials")}
              disabled={anyBusy}
              data-testid="download-credentials-backup"
            >
              {downloadingCredentials ? t("downloadingButton") : t("downloadCredentialsButton")}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("restoreCredentialsTitle")}</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t("restoreCredentialsDescription")}</p>
          <div className="mt-4 space-y-3">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => setCredentialsFile(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-[var(--text-secondary)] file:mr-3 file:rounded-full file:border file:border-[var(--surface-border)] file:bg-[var(--surface-muted)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--text-primary)]"
              disabled={anyBusy}
              data-testid="credentials-restore-file"
            />
            <Button
              onClick={() => void executeRestore("provider-credentials")}
              disabled={anyBusy}
              data-testid="restore-credentials-backup"
            >
              {restoringCredentials ? t("restoringButton") : t("restoreCredentialsButton")}
            </Button>
          </div>
        </div>
      </section>

      {settingsSummary && (
        <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4" data-testid="settings-summary">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t("settingsSummaryTitle")}</h3>
          <div className="mt-2 space-y-2 text-xs text-[var(--text-secondary)]">
            <div>
              <span className="font-medium text-[var(--text-primary)]">{t("settingsSummaryReplacedDomains")}: </span>
              {settingsSummary.replacedDomains.length > 0
                ? settingsSummary.replacedDomains.join(", ")
                : t("settingsSummaryNone")}
            </div>
            <div>
              <span className="font-medium text-[var(--text-primary)]">{t("settingsSummaryMissingUsernames")}: </span>
              {settingsSummary.missingUsernames.length > 0
                ? settingsSummary.missingUsernames.join(", ")
                : t("settingsSummaryNone")}
            </div>
          </div>
        </section>
      )}

      {credentialsSummary && (
        <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4" data-testid="credentials-summary">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t("credentialsSummaryTitle")}</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-[var(--surface-border)] bg-[var(--surface-muted)] p-3">
              <p className="text-xs font-semibold text-[var(--text-primary)]">{t("credentialsSummaryProviderKeys")}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {t("credentialsSummaryCounts", {
                  created: credentialsSummary.providerKeys.created,
                  updated: credentialsSummary.providerKeys.updated,
                  skipped: credentialsSummary.providerKeys.skipped,
                  failed: credentialsSummary.providerKeys.failed,
                })}
              </p>
            </div>
            <div className="rounded-md border border-[var(--surface-border)] bg-[var(--surface-muted)] p-3">
              <p className="text-xs font-semibold text-[var(--text-primary)]">{t("credentialsSummaryProviderOAuth")}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {t("credentialsSummaryCounts", {
                  created: credentialsSummary.providerOAuth.created,
                  updated: credentialsSummary.providerOAuth.updated,
                  skipped: credentialsSummary.providerOAuth.skipped,
                  failed: credentialsSummary.providerOAuth.failed,
                })}
              </p>
            </div>
          </div>
        </section>
      )}

      <ConfirmDialog
        isOpen={showSettingsConfirm}
        onClose={() => setShowSettingsConfirm(false)}
        onConfirm={() => void executeRestore("settings")}
        title={t("settingsConfirmTitle")}
        message={t("settingsConfirmMessage")}
        confirmLabel={t("settingsConfirmAction")}
        cancelLabel={tc("cancel")}
        variant="danger"
      />
    </div>
  );
}
