"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Modal, ModalContent, ModalFooter, ModalHeader, ModalTitle } from "@/components/ui/modal";
import { getOAuthImportFormMode } from "@/lib/oauth-import-ui";

interface OAuthImportFormProps {
  isOpen: boolean;
  providerName: string;
  jsonContent: string;
  status: "idle" | "validating" | "uploading" | "success" | "error";
  errorMessage: string | null;
  supportsBulkImport?: boolean;
  bulkImportSummary?: {
    total: number;
    successCount: number;
    failureCount: number;
    failedResults: Array<{ email: string; error?: string }>;
  } | null;
  onClose: () => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onJsonChange: (value: string) => void;
  onSubmit: () => void;
}

export function OAuthImportForm({
  isOpen,
  providerName,
  jsonContent,
  status,
  errorMessage,
  supportsBulkImport = false,
  bulkImportSummary = null,
  onClose,
  onFileSelect,
  onJsonChange,
  onSubmit,
}: OAuthImportFormProps) {
  const t = useTranslations("providers");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formMode = getOAuthImportFormMode(supportsBulkImport);

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalHeader>
        <ModalTitle>
          {t(formMode.titleKey, { providerName })}
        </ModalTitle>
      </ModalHeader>
      <ModalContent>
        <div className="space-y-4">
          <div className={`rounded-xl border-l-4 p-4 text-sm ${
            formMode.isBulkFirst
              ? "border-amber-300 bg-amber-500/10"
              : "border-blue-300 bg-blue-500/10"
          }`}>
            <div className="font-medium text-[var(--text-primary)]">{t(formMode.subtitleKey)}</div>
            <p className="mt-2 text-[var(--text-secondary)]">
              {t(formMode.descriptionKey)}
            </p>
          </div>

          {formMode.isBulkFirst && (
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface-muted)] p-4 text-xs text-[var(--text-secondary)]">
              <div className="mb-2 font-semibold uppercase tracking-[0.08em] text-[var(--text-primary)]">
                {t(formMode.requirementsTitleKey!)}
              </div>
              <ul className="space-y-1.5">
                <li>{t("importCodexBulkRequirementEmail")}</li>
                <li>{t("importCodexBulkRequirementUnique")}</li>
                <li>{t("importCodexBulkRequirementObject")}</li>
                <li>{t("importCodexBulkRequirementPerEmail")}</li>
              </ul>
            </div>
          )}

          <div>
            <div className="mb-2 text-xs font-medium text-[var(--text-primary)]">{t("uploadJsonLabel")}</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={onFileSelect}
              className="block w-full text-xs text-[var(--text-muted)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--surface-muted)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--text-primary)] hover:file:bg-[var(--surface-hover)] file:cursor-pointer file:transition-colors"
              disabled={status === "uploading"}
            />
          </div>

          <div className="relative">
            <div className="absolute inset-x-0 top-0 flex items-center justify-center">
              <span className="bg-[var(--surface-base)] px-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">{t("orPasteJson")}</span>
            </div>
            <div className="border-t border-[var(--surface-border)] pt-4 mt-2">
              <textarea
                value={jsonContent}
                onChange={(e) => onJsonChange(e.target.value)}
                placeholder={t(formMode.placeholderKey)}
                rows={8}
                disabled={status === "uploading"}
                className="w-full rounded-md border border-[var(--surface-border)] bg-[var(--surface-muted)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30 disabled:opacity-50 resize-y"
              />
            </div>
          </div>

          {status === "error" && errorMessage && (
            <div className="rounded-xl border-l-4 border-red-300 bg-red-500/10 p-3 text-xs text-red-700">
              {errorMessage}
            </div>
          )}

          {status === "success" && (
            <>
              <div className={`rounded-xl border-l-4 p-3 text-xs ${
                bulkImportSummary?.failureCount
                  ? "border-amber-300 bg-amber-500/10 text-amber-800"
                  : "border-green-300 bg-green-500/10 text-green-700"
              }`}>
                {bulkImportSummary
                  ? t("bulkImportSummary", {
                      successCount: bulkImportSummary.successCount,
                      total: bulkImportSummary.total,
                      failureCount: bulkImportSummary.failureCount,
                    })
                  : t("importSuccessMessage")}
              </div>

              {bulkImportSummary && bulkImportSummary.failedResults.length > 0 && (
                <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface-muted)] p-3 text-xs text-[var(--text-primary)]">
                  <div className="mb-2 font-medium">{t("bulkImportFailuresTitle")}</div>
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {bulkImportSummary.failedResults.map((result) => (
                      <div key={result.email} className="break-all">
                        {result.email}: {result.error || t("errorImportCredentialFailed")}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {jsonContent.trim() && status !== "error" && status !== "success" && (
            <div className="rounded-xl border-l-4 border-green-300 bg-green-500/10 p-2 text-xs text-[var(--text-secondary)]">
              {t("jsonContentLoaded", { count: jsonContent.length.toLocaleString() })}
            </div>
          )}
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {status === "success" ? t("oauthDoneButton") : t("cancelButton")}
        </Button>
        {status !== "success" && (
          <Button
            variant="secondary"
            onClick={onSubmit}
            disabled={!jsonContent.trim() || status === "uploading"}
          >
            {status === "uploading" ? t("importingButton") : t(formMode.submitLabelKey)}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
