interface BulkImportCredentialEntry {
  email: string;
  [key: string]: unknown;
}

export type ParsedImportPayload =
  | { mode: "single" }
  | { mode: "bulk"; bulkCredentials: BulkImportCredentialEntry[] };

type TranslateFn = (key: string) => string;

export function parseOAuthImportJson(
  providerId: string | null,
  content: string,
  t: TranslateFn
): { ok: true; value: ParsedImportPayload } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(content);

    if (providerId === "codex" && Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return { ok: false, error: t("errorBulkCodexEmpty") };
      }

      const seenEmails = new Set<string>();

      for (const item of parsed) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return { ok: false, error: t("errorBulkCodexItemObject") };
        }

        const email = (item as Record<string, unknown>).email;
        if (typeof email !== "string" || !email.trim()) {
          return { ok: false, error: t("errorBulkCodexEmailRequired") };
        }

        if (Object.keys(item).length < 2) {
          return { ok: false, error: t("errorBulkCodexCredentialFieldRequired") };
        }

        const normalizedEmail = email.trim().toLowerCase();
        if (seenEmails.has(normalizedEmail)) {
          return { ok: false, error: t("errorBulkCodexDuplicateEmail") };
        }
        seenEmails.add(normalizedEmail);
      }

      return { ok: true, value: { mode: "bulk", bulkCredentials: parsed as BulkImportCredentialEntry[] } };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: t("errorImportJsonObjectRequired") };
    }

    return { ok: true, value: { mode: "single" } };
  } catch {
    return { ok: false, error: t("errorImportJsonInvalid") };
  }
}
