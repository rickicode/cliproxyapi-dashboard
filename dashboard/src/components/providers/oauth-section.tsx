"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalContent, ModalFooter, ModalHeader, ModalTitle } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { extractApiError } from "@/lib/utils";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { OAuthImportForm } from "@/components/providers/oauth-import-form";
import { OAuthActions } from "@/components/providers/oauth-actions";
import { useTranslations } from "next-intl";
import { parseOAuthImportJson, type ParsedImportPayload } from "@/lib/oauth-import-validation";

type ShowToast = ReturnType<typeof useToast>["showToast"];

interface OAuthSectionProps {
  showToast: ShowToast;
  refreshProviders: () => Promise<void>;
  incognitoBrowserEnabled?: boolean;
}

const OAUTH_PROVIDERS = [
  {
    id: "claude" as const,
    name: "Claude Code",
    description: "Anthropic Claude (Pro/Max subscription)",
    authEndpoint: "/api/management/anthropic-auth-url?is_webui=true",
    requiresCallback: true,
  },
  {
    id: "gemini-cli" as const,
    name: "Gemini CLI",
    description: "Google Gemini (via Google OAuth)",
    authEndpoint: "/api/management/gemini-cli-auth-url?project_id=ALL&is_webui=true",
    requiresCallback: true,
  },
  {
    id: "codex" as const,
    name: "Codex",
    description: "OpenAI Codex (Plus/Pro subscription)",
    authEndpoint: "/api/management/codex-auth-url?is_webui=true",
    requiresCallback: true,
  },
  {
    id: "antigravity" as const,
    name: "Antigravity",
    description: "Google Antigravity (via Google OAuth)",
    authEndpoint: "/api/management/antigravity-auth-url?is_webui=true",
    requiresCallback: true,
  },
  {
    id: "iflow" as const,
    name: "iFlow",
    description: "iFlytek iFlow (via OAuth)",
    authEndpoint: "/api/management/iflow-auth-url?is_webui=true",
    requiresCallback: true,
  },
  {
    id: "kimi" as const,
    name: "Kimi",
    description: "Moonshot AI Kimi (device OAuth)",
    authEndpoint: "/api/management/kimi-auth-url?is_webui=true",
    requiresCallback: false,
  },
  {
    id: "qwen" as const,
    name: "Qwen Code",
    description: "Alibaba Qwen Code (device OAuth)",
    authEndpoint: "/api/management/qwen-auth-url?is_webui=true",
    requiresCallback: false,
  },
  {
    id: "copilot" as const,
    name: "GitHub Copilot",
    description: "GitHub Copilot (via GitHub device OAuth)",
    authEndpoint: "/api/management/github-auth-url?is_webui=true",
    requiresCallback: false,
  },
  {
    id: "kiro" as const,
    name: "Kiro",
    description: "AWS CodeWhisperer / Kiro (device OAuth)",
    authEndpoint: "/api/management/kiro-auth-url?is_webui=true",
    requiresCallback: false,
  },
  {
    id: "cursor" as const,
    name: "Cursor",
    description: "Cursor IDE (via PKCE OAuth)",
    authEndpoint: "/api/management/cursor-auth-url?is_webui=true",
    requiresCallback: false,
  },
  {
    id: "codebuddy" as const,
    name: "CodeBuddy",
    description: "Tencent CodeBuddy (via browser OAuth)",
    authEndpoint: "/api/management/codebuddy-auth-url?is_webui=true",
    requiresCallback: false,
  },
] as const;

type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export type OAuthProviderId = OAuthProvider["id"];
const OAUTH_STATUS_POLL_INTERVAL_MS = 5000;
const OAUTH_STATUS_POLL_INTERVAL_HIDDEN_MS = 10000;

const MODAL_STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  WAITING: "waiting",
  SUBMITTING: "submitting",
  POLLING: "polling",
  SUCCESS: "success",
  ERROR: "error",
} as const;

type ModalStatus = (typeof MODAL_STATUS)[keyof typeof MODAL_STATUS];

const CALLBACK_VALIDATION = {
  EMPTY: "empty",
  INVALID: "invalid",
  VALID: "valid",
} as const;

type CallbackValidation =
  (typeof CALLBACK_VALIDATION)[keyof typeof CALLBACK_VALIDATION];

interface BulkImportSummary {
  total: number;
  successCount: number;
  failureCount: number;
  failedResults: Array<{ email: string; error?: string }>;
}

interface AuthUrlResponse {
  status?: string;
  url?: string;
  state?: string;
  user_code?: string;
  method?: string;
  verification_uri?: string;
}
interface AuthStatusResponse {
  status?: string;
  error?: string;
  verification_url?: string;
  user_code?: string;
  url?: string;
}

interface OAuthCallbackResponse {
  status?: number;
  error?: string;
}

const getOAuthProviderById = (id: OAuthProviderId | null) =>
  OAUTH_PROVIDERS.find((provider) => provider.id === id) || null;

function isTabVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

type ValidationResult =
  | { status: typeof CALLBACK_VALIDATION.EMPTY }
  | { status: typeof CALLBACK_VALIDATION.INVALID; reason: "url" | "params" }
  | { status: typeof CALLBACK_VALIDATION.VALID };

const validateCallbackUrl = (value: string): ValidationResult => {
  if (!value.trim()) {
    return { status: CALLBACK_VALIDATION.EMPTY };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.trim());
  } catch {
    return { status: CALLBACK_VALIDATION.INVALID, reason: "url" };
  }
  const code = parsedUrl.searchParams.get("code");
  const state = parsedUrl.searchParams.get("state");
  if (!code || !state) {
    return { status: CALLBACK_VALIDATION.INVALID, reason: "params" };
  }
  return { status: CALLBACK_VALIDATION.VALID };
};

export function OAuthSection({
  showToast,
  refreshProviders,
  incognitoBrowserEnabled = false,
}: OAuthSectionProps) {
  const t = useTranslations("providers");
  const getCallbackMessage = (result: ReturnType<typeof validateCallbackUrl>): string => {
    if (result.status === CALLBACK_VALIDATION.EMPTY) return t("callbackMsgEmpty");
    if (result.status === CALLBACK_VALIDATION.INVALID) {
      return result.reason === "url" ? t("callbackMsgInvalidUrl") : t("callbackMsgMissingParams");
    }
    return t("callbackMsgValid");
  };

  const [isOAuthModalOpen, setIsOAuthModalOpen] = useState(false);
  const [oauthModalStatus, setOauthModalStatus] = useState<ModalStatus>(MODAL_STATUS.IDLE);
  const [selectedOAuthProviderId, setSelectedOAuthProviderId] = useState<OAuthProviderId | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [callbackValidation, setCallbackValidation] = useState<CallbackValidation>(CALLBACK_VALIDATION.EMPTY);
  const [callbackMessage, setCallbackMessage] = useState("");
  const [oauthErrorMessage, setOauthErrorMessage] = useState<string | null>(null);
  const [authLaunchUrl, setAuthLaunchUrl] = useState<string | null>(null);
  const pollingIntervalRef = useRef<number | null>(null);
  const pollingAttemptsRef = useRef(0);
  const noCallbackClaimTimeoutRef = useRef<number | null>(null);
  const noCallbackClaimAttemptsRef = useRef(0);
  const authStateRef = useRef<string | null>(null);
  const selectedOAuthProviderIdRef = useRef<OAuthProviderId | null>(null);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<{ verificationUrl: string; userCode: string } | null>(null);
  const deviceCodePopupOpenedRef = useRef(false);
  const incognitoRef = useRef(incognitoBrowserEnabled);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importProviderId, setImportProviderId] = useState<OAuthProviderId | null>(null);
  const [importJsonContent, setImportJsonContent] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importStatus, setImportStatus] = useState<"idle" | "validating" | "uploading" | "success" | "error">("idle");
  const [importErrorMessage, setImportErrorMessage] = useState<string | null>(null);
  const [importBulkSummary, setImportBulkSummary] = useState<BulkImportSummary | null>(null);

  const selectedOAuthProvider = getOAuthProviderById(selectedOAuthProviderId);
  const selectedOAuthProviderRequiresCallback = selectedOAuthProvider?.requiresCallback ?? true;

  useEffect(() => {
    incognitoRef.current = incognitoBrowserEnabled;
  }, [incognitoBrowserEnabled]);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    pollingAttemptsRef.current = 0;
  }, []);

  const stopNoCallbackClaimPolling = useCallback(() => {
    if (noCallbackClaimTimeoutRef.current !== null) {
      window.clearTimeout(noCallbackClaimTimeoutRef.current);
      noCallbackClaimTimeoutRef.current = null;
    }
    noCallbackClaimAttemptsRef.current = 0;
  }, []);

  const openAuthPopup = (url: string) => {
    const popup = window.open(url, "oauth", "width=600,height=800");
    return popup !== null;
  };

  const pollAuthStatus = (state: string) => {
    if (pollingIntervalRef.current !== null) {
      return;
    }

    pollingIntervalRef.current = window.setInterval(async () => {
      if (!isTabVisible()) {
        return;
      }

      pollingAttemptsRef.current += 1;
      if (pollingAttemptsRef.current > 60) {
        stopPolling();
        setOauthModalStatus(MODAL_STATUS.ERROR);
        setOauthErrorMessage(t("errorOAuthTimeout"));
        return;
      }

      try {
        const res = await fetch(
          `/api/management/get-auth-status?state=${encodeURIComponent(state)}`
        );
        if (!res.ok) {
          stopPolling();
          setOauthModalStatus(MODAL_STATUS.ERROR);
          setOauthErrorMessage(t("errorOAuthCheckStatus"));
          return;
        }

        const data: AuthStatusResponse = await res.json();
        if (data.status === "wait") {
          return;
        }

        if (data.status === "device_code" && data.verification_url && data.user_code) {
          setDeviceCodeInfo({
            verificationUrl: data.verification_url,
            userCode: data.user_code,
          });
          setAuthLaunchUrl(data.verification_url);
          if (!deviceCodePopupOpenedRef.current && !incognitoRef.current) {
            deviceCodePopupOpenedRef.current = true;
            window.open(data.verification_url, "oauth", "width=600,height=800");
          }
          return;
        }

        if (data.status === "ok") {
          stopPolling();
          setOauthModalStatus(MODAL_STATUS.SUCCESS);
          showToast(t("toastOAuthConnected"), "success");
          await refreshProviders();
          return;
        }

        if (data.status === "error") {
          stopPolling();
          setOauthModalStatus(MODAL_STATUS.ERROR);
          setOauthErrorMessage(extractApiError(data, t("errorOAuthFailed")));
          return;
        }
      } catch {
        stopPolling();
        setOauthModalStatus(MODAL_STATUS.ERROR);
        setOauthErrorMessage(t("errorOAuthPollNetwork"));
      }
    }, isTabVisible() ? OAUTH_STATUS_POLL_INTERVAL_MS : OAUTH_STATUS_POLL_INTERVAL_HIDDEN_MS);
  };

  const resetOAuthModalState = () => {
    stopPolling();
    stopNoCallbackClaimPolling();
    setOauthModalStatus(MODAL_STATUS.IDLE);
    selectedOAuthProviderIdRef.current = null;
    setSelectedOAuthProviderId(null);
    authStateRef.current = null;
    setCallbackUrl("");
    setCallbackValidation(CALLBACK_VALIDATION.EMPTY);
    setCallbackMessage(t("callbackMsgEmpty"));
    setOauthErrorMessage(null);
    setAuthLaunchUrl(null);
    setDeviceCodeInfo(null);
    deviceCodePopupOpenedRef.current = false;
  };

  const handleOAuthModalClose = () => {
    setIsOAuthModalOpen(false);
    resetOAuthModalState();
  };

  async function claimOAuthWithoutCallback(providerId: OAuthProviderId, state: string) {
    try {
      const res = await fetch(API_ENDPOINTS.MANAGEMENT.OAUTH_CALLBACK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, state }),
      });

      const data: OAuthCallbackResponse = await res.json().catch(() => ({}));

      if (res.status === 202 || data.status === 202) {
        if (noCallbackClaimAttemptsRef.current >= 25) {
          stopNoCallbackClaimPolling();
          return;
        }

        noCallbackClaimAttemptsRef.current += 1;
        if (noCallbackClaimTimeoutRef.current !== null) {
          window.clearTimeout(noCallbackClaimTimeoutRef.current);
        }
        noCallbackClaimTimeoutRef.current = window.setTimeout(() => {
          void claimOAuthWithoutCallback(providerId, state);
        }, 3000);
        return;
      }

      if (!res.ok) {
        stopNoCallbackClaimPolling();
        stopPolling();
        setOauthModalStatus(MODAL_STATUS.ERROR);
        setOauthErrorMessage(extractApiError(data, t("errorOwnershipClaimFailed")));
        return;
      }

      stopNoCallbackClaimPolling();
    } catch {
      if (noCallbackClaimAttemptsRef.current >= 25) {
        stopNoCallbackClaimPolling();
        return;
      }
      noCallbackClaimAttemptsRef.current += 1;
      if (noCallbackClaimTimeoutRef.current !== null) {
        window.clearTimeout(noCallbackClaimTimeoutRef.current);
      }
      noCallbackClaimTimeoutRef.current = window.setTimeout(() => {
        void claimOAuthWithoutCallback(providerId, state);
      }, 3000);
    }
  }

  const handleOAuthConnect = async (providerId: OAuthProviderId) => {
    const provider = getOAuthProviderById(providerId);
    if (!provider) return;

    selectedOAuthProviderIdRef.current = providerId;
    setSelectedOAuthProviderId(providerId);
    setIsOAuthModalOpen(true);
    setOauthModalStatus(MODAL_STATUS.LOADING);
    setOauthErrorMessage(null);
    setCallbackUrl("");
    setCallbackValidation(CALLBACK_VALIDATION.EMPTY);
    setCallbackMessage(t("callbackMsgEmpty"));
    setAuthLaunchUrl(null);

    try {
      const res = await fetch(provider.authEndpoint);
      if (!res.ok) {
        const errorData: unknown = await res.json().catch(() => null);
        setOauthModalStatus(MODAL_STATUS.ERROR);
        setOauthErrorMessage(
          extractApiError(errorData, `Failed to start OAuth flow (HTTP ${res.status}).`)
        );
        return;
      }

      const data: AuthUrlResponse = await res.json();
      if (!data.state) {
        setOauthModalStatus(MODAL_STATUS.ERROR);
        setOauthErrorMessage(t("errorOAuthMissingState"));
        return;
      }

      if (!data.url && data.method === "device_code") {
        authStateRef.current = data.state;
        setOauthModalStatus(MODAL_STATUS.POLLING);
        setCallbackValidation(CALLBACK_VALIDATION.VALID);
        setCallbackMessage(t("callbackMsgWaitingDevice"));
        showToast(t("toastOAuthInitDevice"), "info");
        pollAuthStatus(data.state);
        stopNoCallbackClaimPolling();
        void claimOAuthWithoutCallback(provider.id, data.state);
        return;
      }

      if (!data.url) {
        setOauthModalStatus(MODAL_STATUS.ERROR);
        setOauthErrorMessage(t("errorOAuthMissingUrl"));
        return;
      }
      setAuthLaunchUrl(data.url);

      const shouldOpenPopup = !incognitoBrowserEnabled;
      if (shouldOpenPopup) {
        const popupOpened = openAuthPopup(data.url);
        if (!popupOpened) {
          setOauthModalStatus(MODAL_STATUS.ERROR);
          setOauthErrorMessage(t("errorOAuthPopupBlocked"));
          return;
        }
      }
      authStateRef.current = data.state;
      if (provider.requiresCallback) {
        setOauthModalStatus(MODAL_STATUS.WAITING);
        setCallbackValidation(CALLBACK_VALIDATION.EMPTY);
        setCallbackMessage(t("callbackMsgEmpty"));
        showToast(incognitoBrowserEnabled ? t("toastOAuthFollowStepsIncognito") : t("toastOAuthFollowStepsPopup"), "info");
      } else {
        setOauthModalStatus(MODAL_STATUS.POLLING);
        setCallbackValidation(CALLBACK_VALIDATION.VALID);
        setCallbackMessage(incognitoBrowserEnabled ? t("callbackMsgNoCallbackIncognito") : t("callbackMsgNoCallbackPopup"));
        showToast(incognitoBrowserEnabled ? t("toastOAuthNoCallbackIncognito") : t("toastOAuthNoCallbackPopup"), "info");
        if (data.user_code && data.url) {
          setDeviceCodeInfo({
            verificationUrl: data.url,
            userCode: data.user_code,
          });
          deviceCodePopupOpenedRef.current = shouldOpenPopup;
        }
        stopNoCallbackClaimPolling();
        void claimOAuthWithoutCallback(providerId, data.state);
      }

      pollAuthStatus(data.state);
    } catch {
      setOauthModalStatus(MODAL_STATUS.ERROR);
      setOauthErrorMessage(t("errorOAuthStartNetwork"));
    }
  };

  const handleCallbackChange = (value: string) => {
    setCallbackUrl(value);
    const result = validateCallbackUrl(value);
    setCallbackValidation(result.status);
    setCallbackMessage(getCallbackMessage(result));
  };

  const handleSubmitCallback = async () => {
    const currentProvider = selectedOAuthProviderIdRef.current;
    const currentState = authStateRef.current;
    if (!currentProvider || !currentState) {
      console.warn("[OAuth] Submit failed - missing provider or state");
      setOauthModalStatus(MODAL_STATUS.ERROR);
      setOauthErrorMessage(t("errorOAuthMissingProviderState"));
      return;
    }

    const result = validateCallbackUrl(callbackUrl);
    if (result.status !== CALLBACK_VALIDATION.VALID) {
      setCallbackValidation(result.status);
      setCallbackMessage(getCallbackMessage(result));
      return;
    }

    setOauthModalStatus(MODAL_STATUS.SUBMITTING);
    setOauthErrorMessage(null);

    try {
      const res = await fetch(API_ENDPOINTS.MANAGEMENT.OAUTH_CALLBACK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: currentProvider,
          callbackUrl: callbackUrl.trim(),
        }),
      });

      const data: OAuthCallbackResponse = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOauthModalStatus(MODAL_STATUS.ERROR);
        setOauthErrorMessage(
          extractApiError(data, t("errorRelayCallbackFailed"))
        );
        return;
      }

      stopPolling();
      setOauthModalStatus(MODAL_STATUS.POLLING);
      pollAuthStatus(currentState);
    } catch {
      setOauthModalStatus(MODAL_STATUS.ERROR);
      setOauthErrorMessage(t("errorOAuthCallbackNetwork"));
    }
  };

  const openImportModal = (providerId: OAuthProviderId) => {
    setImportProviderId(providerId);
    setImportJsonContent("");
    setImportFileName("");
    setImportStatus("idle");
    setImportErrorMessage(null);
    setImportBulkSummary(null);
    setIsImportModalOpen(true);
  };

  const closeImportModal = () => {
    setIsImportModalOpen(false);
    setImportProviderId(null);
    setImportJsonContent("");
    setImportFileName("");
    setImportStatus("idle");
    setImportErrorMessage(null);
    setImportBulkSummary(null);
  };

  const handleImportFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".json")) {
      setImportFileName("");
      setImportJsonContent("");
      setImportErrorMessage(t("errorImportJsonFileRequired"));
      setImportStatus("error");
      setImportBulkSummary(null);
      return;
    }

    if (file.size > 1024 * 1024) {
      setImportFileName("");
      setImportJsonContent("");
      setImportErrorMessage(t("errorImportJsonTooLarge"));
      setImportStatus("error");
      setImportBulkSummary(null);
      return;
    }

    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === "string") {
        setImportJsonContent(content);
        validateImportJson(content);
      }
    };
    reader.onerror = () => {
      setImportErrorMessage(t("errorImportJsonReadFailed"));
      setImportStatus("error");
      setImportBulkSummary(null);
    };
    reader.readAsText(file);
  };

  const parseImportJson = (content: string): { ok: true; value: ParsedImportPayload } | { ok: false; error: string } =>
    parseOAuthImportJson(importProviderId, content, t);

  const validateImportJson = (content: string) => {
    const parsed = parseImportJson(content);
    if (!parsed.ok) {
      setImportErrorMessage(parsed.error);
      setImportStatus("error");
      setImportBulkSummary(null);
      return false;
    }

    setImportErrorMessage(null);
    setImportStatus("idle");
    setImportBulkSummary(null);
    return true;
  };

  const handleImportJsonChange = (value: string) => {
    setImportJsonContent(value);
    if (value.trim()) {
      validateImportJson(value);
    } else {
      setImportErrorMessage(null);
      setImportStatus("idle");
      setImportBulkSummary(null);
    }
  };

  const handleImportSubmit = async () => {
    if (!importProviderId || !importJsonContent.trim()) return;

    const parsedImport = parseImportJson(importJsonContent);
    if (!parsedImport.ok) {
      setImportErrorMessage(parsedImport.error);
      setImportStatus("error");
      setImportBulkSummary(null);
      return;
    }

    const fileName = importFileName || `${importProviderId}-credential.json`;

    setImportStatus("uploading");
    setImportErrorMessage(null);
    setImportBulkSummary(null);

    try {
      const requestBody = parsedImport.value.mode === "bulk"
        ? {
            provider: importProviderId,
            bulkCredentials: parsedImport.value.bulkCredentials,
          }
        : {
            provider: importProviderId,
            fileName,
            fileContent: importJsonContent.trim(),
          };

      const res = await fetch(API_ENDPOINTS.PROVIDERS.OAUTH_IMPORT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setImportStatus("error");
        setImportErrorMessage(extractApiError(data, t("errorImportCredentialFailed")));
        return;
      }

      if (parsedImport.value.mode === "bulk") {
        const results = Array.isArray(data.data?.results) ? data.data.results : [];
        const summary = data.data?.summary as {
          total?: number;
          successCount?: number;
          failureCount?: number;
        } | undefined;
        const nextSummary: BulkImportSummary = {
          total: summary?.total ?? results.length,
          successCount: summary?.successCount ?? results.filter((result: { ok?: boolean }) => result.ok).length,
          failureCount: summary?.failureCount ?? results.filter((result: { ok?: boolean }) => !result.ok).length,
          failedResults: results
            .filter((result: { ok?: boolean }) => !result.ok)
            .map((result: { email?: string; error?: string }) => ({
              email: result.email || t("unknownLabel"),
              error: result.error,
            })),
        };

        setImportBulkSummary(nextSummary);
        setImportStatus("success");

        if (nextSummary.failureCount === 0) {
          showToast(t("toastOAuthBulkImportSuccess", { count: nextSummary.successCount }), "success");
        } else if (nextSummary.successCount === 0) {
          showToast(t("toastOAuthBulkImportFailed"), "error");
        } else {
          showToast(
            t("toastOAuthBulkImportPartial", {
              successCount: nextSummary.successCount,
              failureCount: nextSummary.failureCount,
            }),
            "success"
          );
        }

        await refreshProviders();
        return;
      }

      setImportStatus("success");
      showToast(t("toastOAuthImportSuccess"), "success");
      await refreshProviders();
    } catch {
      setImportStatus("error");
      setImportBulkSummary(null);
      setImportErrorMessage(t("errorImportNetwork"));
    }
  };

  useEffect(() => {
    return () => {
      stopPolling();
      stopNoCallbackClaimPolling();
    };
  }, [stopNoCallbackClaimPolling, stopPolling]);

  const isOAuthSubmitDisabled =
    oauthModalStatus === MODAL_STATUS.LOADING ||
    oauthModalStatus === MODAL_STATUS.SUBMITTING ||
    oauthModalStatus === MODAL_STATUS.POLLING ||
    oauthModalStatus === MODAL_STATUS.SUCCESS ||
    callbackValidation !== CALLBACK_VALIDATION.VALID;

  const importProviderName = importProviderId
    ? getOAuthProviderById(importProviderId)?.name || importProviderId
    : "";

  return (
    <>
      <div id="provider-oauth" className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('oauthAccountsTitle')}</h2>
            <p className="text-xs text-[var(--text-muted)]">{t('oauthSectionDescription')}</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-sm border border-[var(--surface-border)] bg-[var(--surface-base)] p-3 text-xs text-[var(--text-muted)]">
            <strong className="text-[var(--text-primary)]">{t("noteLabel")}</strong>{" "}
            {incognitoBrowserEnabled
              ? t("oauthIncognitoNote")
              : t("oauthPopupNote")}
          </div>

          <OAuthActions
            providers={OAUTH_PROVIDERS}
            onConnect={handleOAuthConnect}
            onImport={openImportModal}
          />
        </div>
      </div>

      <Modal isOpen={isOAuthModalOpen} onClose={handleOAuthModalClose}>
        <ModalHeader>
          <ModalTitle>
            {t("oauthConnectTitle", { name: selectedOAuthProvider?.name ?? "" })}
          </ModalTitle>
        </ModalHeader>
        <ModalContent>
          {oauthModalStatus === MODAL_STATUS.LOADING && (
            <div className="rounded-xl border-l-4 border-[var(--surface-border)] bg-[var(--surface-muted)] p-4 text-sm text-[var(--text-secondary)]">
              Fetching authorization link...
            </div>
          )}

          {authLaunchUrl && (oauthModalStatus === MODAL_STATUS.WAITING || oauthModalStatus === MODAL_STATUS.POLLING || oauthModalStatus === MODAL_STATUS.ERROR) && (
            <div className={`rounded-xl border-l-4 p-4 text-sm ${
              incognitoBrowserEnabled
                ? "border-amber-300 bg-amber-500/10 text-amber-900"
                : "border-[var(--surface-border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]"
            }`}>
              <div className="font-medium text-[var(--text-primary)]">
                {incognitoBrowserEnabled ? "Open This URL In A Private Window" : "Authorization URL"}
              </div>
              <p className="mt-2 text-[var(--text-secondary)]">
                {incognitoBrowserEnabled
                  ? t("oauthOpenManuallyIncognito")
                  : t("oauthOpenManually")}
              </p>
              <div className="mt-3 rounded-lg bg-[var(--surface-muted)] p-3">
                <input
                  readOnly
                  value={authLaunchUrl}
                  className="w-full bg-transparent font-mono text-xs text-[var(--text-primary)] outline-none"
                />
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(authLaunchUrl);
                      showToast(t("toastOAuthCopied"), "success");
                    } catch {
                      showToast(t("toastOAuthCopyFailed"), "error");
                    }
                  }}
                >
                  {t("oauthCopyUrlButton")}
                </Button>
                {!incognitoBrowserEnabled && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const popupOpened = openAuthPopup(authLaunchUrl);
                      if (!popupOpened) {
                        showToast(t("errorOAuthPopupBlocked"), "error");
                      }
                    }}
                  >
                    {t("oauthOpenAgainButton")}
                  </Button>
                )}
              </div>
            </div>
          )}

          {(oauthModalStatus === MODAL_STATUS.WAITING ||
            oauthModalStatus === MODAL_STATUS.SUBMITTING ||
            oauthModalStatus === MODAL_STATUS.POLLING ||
            oauthModalStatus === MODAL_STATUS.ERROR) &&
            selectedOAuthProviderRequiresCallback && (
            <div className="space-y-4">
              <div className="rounded-xl border-l-4 border-[var(--surface-border)] bg-[var(--surface-hover)] p-4 text-sm">
                <div className="font-medium text-[var(--text-primary)]">
                  Step-by-step
                </div>
                <ol className="mt-3 list-decimal space-y-2 pl-4 text-[var(--text-primary)]">
                  <li>{incognitoBrowserEnabled ? "Open the authorization URL above in a private/incognito window and sign in there." : "Log in and authorize in the popup window."}</li>
                  <li>
                    After authorizing, the page will fail to load (this is
                    expected).
                  </li>
                  <li>
                    Our server runs remotely, so the OAuth redirect can&apos;t reach
                    it directly. Copy the FULL URL from the address bar.
                  </li>
                  <li>{t("oauthStep4")}</li>
                </ol>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium text-[var(--text-primary)]">
                  Paste callback URL
                </div>
                <Input
                  type="text"
                  name="callbackUrl"
                  value={callbackUrl}
                  onChange={handleCallbackChange}
                  placeholder="https://localhost/callback?code=...&state=..."
                  disabled={
                    oauthModalStatus === MODAL_STATUS.SUBMITTING ||
                    oauthModalStatus === MODAL_STATUS.POLLING
                  }
                  className="font-mono"
                />
                <div
                  className={`mt-2 rounded-xl border-l-4 p-2 text-xs ${
                    callbackValidation === CALLBACK_VALIDATION.VALID
                      ? "border-green-300 bg-green-500/10 text-green-700"
                      : callbackValidation === CALLBACK_VALIDATION.INVALID
                        ? "border-red-300 bg-red-500/10 text-red-700"
                        : "border-[var(--surface-border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]"
                  }`}
                >
                  {callbackMessage}
                </div>
              </div>
            </div>
          )}

          {(oauthModalStatus === MODAL_STATUS.WAITING ||
            oauthModalStatus === MODAL_STATUS.POLLING ||
            oauthModalStatus === MODAL_STATUS.ERROR) &&
            !selectedOAuthProviderRequiresCallback && (
            <div className="rounded-xl border-l-4 border-[var(--surface-border)] bg-[var(--surface-hover)] p-4 text-sm">
              <div className="font-medium text-[var(--text-primary)]">
                Device Authorization
              </div>
              <ol className="mt-3 list-decimal space-y-2 pl-4 text-[var(--text-primary)]">
                <li>{incognitoBrowserEnabled ? "Open the authorization URL above in a private/incognito window." : "A browser window has opened with the authorization page."}</li>
                <li>Log in and approve the access request.</li>
                <li>{t("oauthDeviceStep3")}</li>
              </ol>
              {deviceCodeInfo && (
                <div className="mt-4 space-y-3">
                  <div className="rounded-lg bg-[var(--surface-muted)] p-3">
                    <p className="text-xs font-medium text-[var(--text-muted)]">{t("oauthYourAuthCode")}</p>
                    <p className="mt-1 select-all font-mono text-lg font-bold tracking-wider text-[var(--text-primary)]">{deviceCodeInfo.userCode}</p>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">
                    Enter this code at{" "}
                    <a href={deviceCodeInfo.verificationUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                      {deviceCodeInfo.verificationUrl}
                    </a>
                  </p>
                </div>
              )}
            </div>
          )}

          {oauthModalStatus === MODAL_STATUS.POLLING && (
            <div className="mt-4 rounded-xl border-l-4 border-blue-300 bg-blue-500/10 p-4 text-sm text-blue-700">
              {selectedOAuthProviderRequiresCallback
                ? t("oauthPollingCallbackMsg")
                : t("oauthPollingNoCallbackMsg")}
            </div>
          )}

          {oauthModalStatus === MODAL_STATUS.SUCCESS && (
            <div className="rounded-xl border-l-4 border-green-300 bg-green-500/10 p-4 text-sm text-green-700">
              OAuth account connected successfully.
            </div>
          )}

          {oauthModalStatus === MODAL_STATUS.ERROR && oauthErrorMessage && (
            <div className="rounded-xl border-l-4 border-red-300 bg-red-500/10 p-4 text-sm text-red-700">
              {oauthErrorMessage}
            </div>
          )}
        </ModalContent>
        <ModalFooter>
          <Button variant="ghost" onClick={handleOAuthModalClose}>
            {t("oauthCloseButton")}
          </Button>
          {oauthModalStatus !== MODAL_STATUS.SUCCESS && selectedOAuthProviderRequiresCallback && (
            <Button
              variant="secondary"
              onClick={handleSubmitCallback}
              disabled={isOAuthSubmitDisabled}
            >
              {oauthModalStatus === MODAL_STATUS.SUBMITTING
                ? t("oauthSubmittingButton")
                : oauthModalStatus === MODAL_STATUS.POLLING
                  ? t("oauthWaitingButton")
                  : t("oauthSubmitUrlButton")}
            </Button>
          )}
          {oauthModalStatus === MODAL_STATUS.SUCCESS && (
            <Button variant="secondary" onClick={handleOAuthModalClose}>
              {t("oauthDoneButton")}
            </Button>
          )}
        </ModalFooter>
      </Modal>
      <OAuthImportForm
        isOpen={isImportModalOpen}
        providerName={importProviderName}
        jsonContent={importJsonContent}
        status={importStatus}
        errorMessage={importErrorMessage}
        supportsBulkImport={importProviderId === "codex"}
        bulkImportSummary={importBulkSummary}
        onClose={closeImportModal}
        onFileSelect={handleImportFileSelect}
        onJsonChange={handleImportJsonChange}
        onSubmit={handleImportSubmit}
      />
    </>
  );
}
