"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ModelSelector } from "@/components/model-selector";
import { OpenCodeConfigGenerator } from "@/components/opencode-config-generator";
import { OhMyOpenCodeConfigGenerator } from "@/components/oh-my-opencode-config-generator";
import type { OhMyOpenCodeFullConfig } from "@/lib/config-generators/oh-my-opencode-types";

interface OAuthAccountEntry {
  id: string;
  name: string;
  type?: string;
  provider?: string;
  disabled?: boolean;
}

interface ConfigData {
  "gemini-api-key"?: unknown;
  "claude-api-key"?: unknown;
  "codex-api-key"?: unknown;
  "openai-compatibility"?: unknown;
  "oauth-model-alias"?: unknown;
}

interface ModelDefinitionLike {
  name: string;
  context: number;
  output: number;
  attachment: boolean;
  reasoning: boolean;
  modalities: { input: string[]; output: string[] };
  options?: Record<string, unknown>;
}

interface QuickStartConfigSectionProps {
   apiKeys: { key: string; name: string | null }[];
   config: unknown;
   oauthAccounts: OAuthAccountEntry[];
   availableModels: string[];
   allModels: Record<string, ModelDefinitionLike>;
   modelSourceMap: Map<string, string>;
   initialExcludedModels: string[];
   agentOverrides?: OhMyOpenCodeFullConfig;
   hasSyncActive: boolean;
   isSubscribed?: boolean;
   proxyUrl: string;
 }

export function QuickStartConfigSection({
   apiKeys,
   config,
   oauthAccounts,
   availableModels,
   allModels,
   modelSourceMap,
   initialExcludedModels,
   agentOverrides,
   hasSyncActive,
   isSubscribed = false,
   proxyUrl,
 }: QuickStartConfigSectionProps) {
  const [excludedModels, setExcludedModels] = useState<string[]>(initialExcludedModels);

  return (
    <>
      {availableModels.length > 0 && (
        <ModelSelector
          availableModels={availableModels}
          modelSourceMap={modelSourceMap}
          initialExcludedModels={initialExcludedModels}
          onSelectionChange={setExcludedModels}
          isLocked={isSubscribed}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="flex items-center gap-3">
             <span className="w-6 h-6 rounded-lg bg-orange-500/20 border border-orange-400/30 flex items-center justify-center text-sm" aria-hidden="true">&#9654;</span>
               Using with OpenCode
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-white/70">
              {hasSyncActive ? (
                <span>Config auto-syncs via <code className="px-1.5 py-0.5 rounded bg-white/10 text-violet-300 text-xs font-mono">opencode-cliproxyapi-sync@latest</code> plugin.</span>
              ) : (
                <span>Place at <code className="px-1.5 py-0.5 rounded bg-white/10 text-orange-300 text-xs font-mono break-all">~/.config/opencode/opencode.json</code> or project root.</span>
              )}
            </p>

            <OpenCodeConfigGenerator
               apiKeys={apiKeys}
               config={config as ConfigData | null}
               oauthAccounts={oauthAccounts}
               models={allModels as Record<string, import("@/lib/config-generators/opencode").ModelDefinition>}
               excludedModels={excludedModels}
               proxyUrl={proxyUrl}
              />

            <div className="space-y-1.5 text-sm text-white/70">
              <p className="flex items-start gap-2">
                <span className="text-orange-300">•</span>
                <span>Add providers via <a href="/dashboard/providers" className="text-violet-400 font-medium hover:text-violet-300 underline underline-offset-2 decoration-violet-400/30">Providers</a></span>
              </p>
              <p className="flex items-start gap-2">
                <span className="text-orange-300">•</span>
                <span>Set default model: <code className="px-1.5 py-0.5 rounded bg-white/10 text-orange-300 text-xs font-mono break-all">cliproxyapi/model-name</code></span>
              </p>
            </div>
           </div>

            <div className="flex items-start gap-3 mt-4 p-3 rounded-lg bg-white/5 border border-white/10">
              <span className="text-lg">💡</span>
              <p className="text-sm text-white/70">
                Auto-sync: Get token in <a href="/dashboard/settings" className="text-violet-400 font-medium hover:text-violet-300 underline underline-offset-2 decoration-violet-400/30">Settings</a>, install <code className="px-1.5 py-0.5 rounded bg-white/10 text-violet-300 text-xs font-mono">opencode-cliproxyapi-sync@latest</code>
              </p>
            </div>
         </CardContent>
       </Card>

       <Card>
         <CardHeader>
           <CardTitle>
             <span className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-lg bg-pink-500/20 border border-pink-400/30 flex items-center justify-center text-sm" aria-hidden="true">&#9654;</span>
                Using with Oh-My-OpenCode
             </span>
           </CardTitle>
         </CardHeader>
        <CardContent>
          <OhMyOpenCodeConfigGenerator
            apiKeys={apiKeys}
            config={config as ConfigData | null}
            oauthAccounts={oauthAccounts}
            proxyModelIds={availableModels}
            excludedModels={excludedModels}
            agentOverrides={agentOverrides}
          />
        </CardContent>
      </Card>
    </>
  );
}
