export function normalizeQuotaProvider(provider: string): string {
  return provider === "github" || provider === "copilot" || provider === "github-copilot"
    ? "github-copilot"
    : provider;
}

export function getQuotaProviderLabel(provider: string): string {
  const canonicalProvider = normalizeQuotaProvider(provider);

  if (canonicalProvider === "github-copilot") {
    return "Copilot";
  }

  return canonicalProvider.charAt(0).toUpperCase() + canonicalProvider.slice(1);
}
