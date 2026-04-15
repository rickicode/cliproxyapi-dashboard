import { describe, expect, it } from "vitest";
import { getOAuthImportFormMode } from "@/lib/oauth-import-ui";

describe("getOAuthImportFormMode", () => {
  it("treats codex as bulk-first", () => {
    expect(getOAuthImportFormMode(true)).toEqual({
      isBulkFirst: true,
      submitLabelKey: "importCodexAccountsButton",
      titleKey: "importCodexBulkTitle",
      subtitleKey: "importCodexBulkSubtitle",
      descriptionKey: "importCodexBulkDescription",
      placeholderKey: "importCodexBulkPlaceholder",
      requirementsTitleKey: "importCodexBulkRequirementsTitle",
    });
  });

  it("keeps generic import mode for other providers", () => {
    expect(getOAuthImportFormMode(false)).toEqual({
      isBulkFirst: false,
      submitLabelKey: "importCredentialButton",
      titleKey: "importCredentialTitle",
      subtitleKey: "importCredentialSubtitle",
      descriptionKey: "importCredentialDescription",
      placeholderKey: "importCredentialPlaceholder",
      requirementsTitleKey: null,
    });
  });
});
