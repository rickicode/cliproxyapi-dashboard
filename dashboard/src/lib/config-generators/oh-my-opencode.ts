import type { OhMyOpenCodeFullConfig } from "./oh-my-opencode-types";

export type { OAuthAccount, ConfigData } from "./shared";

export const TIER_1 = [
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "gemini-claude-opus-4-5-thinking",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gemini-claude-sonnet-4-5-thinking",
  "gemini-claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "gemini-3-pro-preview",
] as const;

export const TIER_2 = [
  "gemini-claude-sonnet-4-5-thinking",
  "gemini-claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5-codex",
  "gemini-3-pro-preview",
  "gemini-claude-opus-4-5-thinking",
  "claude-opus-4-20250514",
] as const;

export const TIER_3 = [
  "claude-haiku-4-5-20251001",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gpt-5-codex-mini",
  "gpt-5",
  "gemini-claude-sonnet-4-5",
] as const;

export const TIER_4 = [
  "gemini-3-pro-preview",
  "gemini-3-pro-image-preview",
  "gemini-claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-20250514",
] as const;

export function pickBestModel(availableModels: string[], tierPriority: readonly string[]): string | null {
  for (const pattern of tierPriority) {
    const match = availableModels.find((m) => m.startsWith(pattern));
    if (match) return match;
  }
  return null;
}

export const AGENT_ROLES = {
  sisyphus: { tier: TIER_1, label: "Orchestrator" },
  atlas: { tier: TIER_1, label: "Master orchestrator" },
  prometheus: { tier: TIER_1, label: "Planner" },
  metis: { tier: TIER_2, label: "Plan consultant" },
  oracle: { tier: TIER_1, label: "Technical advisor" },
  librarian: { tier: TIER_2, label: "Research" },
  explore: { tier: TIER_3, label: "Fast exploration" },
  "multimodal-looker": { tier: TIER_2, label: "Vision" },
  momus: { tier: TIER_2, label: "Reviewer" },
} as const;

export const CATEGORY_ROLES = {
  "visual-engineering": { tier: TIER_4, label: "UI work" },
  ultrabrain: { tier: TIER_1, label: "Hard logic" },
  deep: { tier: TIER_1, label: "Deep problem solving" },
  artistry: { tier: TIER_4, label: "Creative work" },
  quick: { tier: TIER_3, label: "Trivial tasks" },
  "unspecified-low": { tier: TIER_2, label: "Low effort general" },
  "unspecified-high": { tier: TIER_1, label: "High effort general" },
  writing: { tier: TIER_3, label: "Documentation" },
} as const;

interface ModelAssignment {
  model: string;
  variant?: string;
  temperature?: number;
  prompt_append?: string;
  description?: string;
}

// Backward compatibility type alias
export type AgentModelOverrides = OhMyOpenCodeFullConfig;

export function buildOhMyOpenCodeConfig(
  availableModels: string[],
  overrides?: OhMyOpenCodeFullConfig
): Record<string, unknown> | null {
  const agents: Record<string, ModelAssignment> = {};
  for (const [agent, role] of Object.entries(AGENT_ROLES)) {
    const agentOverride = overrides?.agents?.[agent];
    const overrideModel = agentOverride?.model;
    let entry: ModelAssignment;
    if (overrideModel && availableModels.includes(overrideModel)) {
      entry = { model: `cliproxyapi/${overrideModel}` };
    } else {
      const model = pickBestModel(availableModels, role.tier);
      if (!model) continue;
      entry = { model: `cliproxyapi/${model}` };
    }
    if (agentOverride?.variant) entry.variant = agentOverride.variant;
    if (agentOverride?.temperature !== undefined) entry.temperature = agentOverride.temperature;
    if (agentOverride?.prompt_append) entry.prompt_append = agentOverride.prompt_append;
    agents[agent] = entry;
  }

  const categories: Record<string, ModelAssignment> = {};
  for (const [category, role] of Object.entries(CATEGORY_ROLES)) {
    const categoryOverride = overrides?.categories?.[category];
    const overrideModel = categoryOverride?.model;
    let entry: ModelAssignment;
    if (overrideModel && availableModels.includes(overrideModel)) {
      entry = { model: `cliproxyapi/${overrideModel}` };
    } else {
      const model = pickBestModel(availableModels, role.tier);
      if (!model) continue;
      entry = { model: `cliproxyapi/${model}` };
    }
    if (categoryOverride?.variant) entry.variant = categoryOverride.variant;
    if (categoryOverride?.temperature !== undefined) entry.temperature = categoryOverride.temperature;
    if (categoryOverride?.description) entry.description = categoryOverride.description;
    categories[category] = entry;
  }

  if (Object.keys(agents).length === 0 && Object.keys(categories).length === 0) {
    return null;
  }

  const config: Record<string, unknown> = {
    $schema:
      "https://raw.githubusercontent.com/code-yeongyu/oh-my-opencode/master/assets/oh-my-opencode.schema.json",
  };

  if (Object.keys(agents).length > 0) {
    config.agents = agents;
  }
  if (Object.keys(categories).length > 0) {
    config.categories = categories;
  }

  config.auto_update = false;

  // Disabled arrays — only include if non-empty
  if (overrides?.disabled_agents?.length) config.disabled_agents = overrides.disabled_agents;
  if (overrides?.disabled_skills?.length) config.disabled_skills = overrides.disabled_skills;
  if (overrides?.disabled_hooks?.length) config.disabled_hooks = overrides.disabled_hooks;
  if (overrides?.disabled_commands?.length) config.disabled_commands = overrides.disabled_commands;
  if (overrides?.disabled_mcps?.length) config.disabled_mcps = overrides.disabled_mcps;

  // Tmux — merge with defaults (same pattern as sisyphus_agent, git_master, etc.)
  if (overrides?.tmux) {
    config.tmux = {
      enabled: true,
      layout: "main-vertical",
      main_pane_size: 60,
      main_pane_min_width: 120,
      agent_pane_min_width: 40,
      ...overrides.tmux,
    };
  }

  // Background task — merge user overrides with defaults
  config.background_task = { defaultConcurrency: 5, ...overrides?.background_task };

  // Browser automation — only if configured
  if (overrides?.browser_automation_engine) config.browser_automation_engine = overrides.browser_automation_engine;

  // Sisyphus agent — merge with defaults
  config.sisyphus_agent = { planner_enabled: true, replace_plan: true, ...overrides?.sisyphus_agent };

  // Git master — merge with defaults
  config.git_master = { commit_footer: false, include_co_authored_by: false, ...overrides?.git_master };

  // LSP — only if configured
  if (overrides?.lsp && Object.keys(overrides.lsp).length > 0) {
    config.lsp = overrides.lsp;
  }

  return config;
}
