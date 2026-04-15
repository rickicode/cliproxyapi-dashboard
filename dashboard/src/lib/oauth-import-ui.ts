export function getOAuthImportFormMode(supportsBulkImport: boolean) {
  if (supportsBulkImport) {
    return {
      isBulkFirst: true,
      submitLabelKey: "importCodexAccountsButton",
      titleKey: "importCodexBulkTitle",
      subtitleKey: "importCodexBulkSubtitle",
      descriptionKey: "importCodexBulkDescription",
      placeholderKey: "importCodexBulkPlaceholder",
      requirementsTitleKey: "importCodexBulkRequirementsTitle",
    } as const;
  }

  return {
    isBulkFirst: false,
    submitLabelKey: "importCredentialButton",
    titleKey: "importCredentialTitle",
    subtitleKey: "importCredentialSubtitle",
    descriptionKey: "importCredentialDescription",
    placeholderKey: "importCredentialPlaceholder",
    requirementsTitleKey: null,
  } as const;
}
