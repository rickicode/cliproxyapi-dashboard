function normalizeIdentifier(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isMeaningfulProviderValue(value: string | undefined): value is string {
  const normalized = normalizeIdentifier(value);
  return normalized !== null && normalized !== "unknown" && normalized !== "n/a" && normalized !== "none";
}

export function inferOAuthProviderFromIdentifiers(...values: Array<string | undefined>): string | null {
  const candidates = values
    .map(normalizeIdentifier)
    .filter((value): value is string => value !== null);

  for (const candidate of candidates) {
    if (candidate.includes("claude-") || candidate.includes("claude_")) return "claude";
    if (candidate.includes("codex-") || candidate.includes("codex_")) return "codex";
    if (
      candidate.includes("gemini-cli") ||
      candidate.includes("gemini_cli") ||
      candidate.includes("gemini-") ||
      candidate.includes("gemini_")
    ) return "gemini-cli";
    if (candidate.includes("antigravity-") || candidate.includes("antigravity_")) return "antigravity";
    if (candidate.includes("kimi-") || candidate.includes("kimi_")) return "kimi";
    if (
      candidate.includes("github-copilot") ||
      candidate.includes("github_copilot") ||
      candidate.includes("copilot-") ||
      candidate.includes("copilot_")
    ) return "copilot";
    if (candidate.includes("github-") || candidate.includes("github_")) return "github";
    if (candidate.includes("cursor-") || candidate.includes("cursor_")) return "cursor";
    if (candidate.includes("qwen-") || candidate.includes("qwen_")) return "qwen";
    if (candidate.includes("iflow-") || candidate.includes("iflow_")) return "iflow";
    if (candidate.includes("codebuddy-") || candidate.includes("codebuddy_")) return "codebuddy";
    if (candidate.includes("kiro-") || candidate.includes("kiro_")) return "kiro";
  }

  return null;
}
