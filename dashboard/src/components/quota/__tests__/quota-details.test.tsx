import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import enMessages from "../../../../messages/en.json";
import { QuotaDetails } from "@/components/quota/quota-details";

const noop = vi.fn();

function renderQuotaDetails(props: Partial<React.ComponentProps<typeof QuotaDetails>> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <QuotaDetails
        filteredAccounts={[]}
        expandedCards={{}}
        onToggleCard={noop}
        loading={false}
        error={false}
        modelFirstOnlyView={false}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

describe("QuotaDetails", () => {
  it("shows a local loading fallback while details are still loading", () => {
    const markup = renderQuotaDetails({ loading: true });

    expect(markup).toContain("Loading...");
    expect(markup).not.toContain("No accounts found for the selected filter.");
  });

  it("keeps the local detail error fallback when details fail", () => {
    const markup = renderQuotaDetails({ error: true, loading: false });

    expect(markup).toContain("Unable to load account details. Summary data is still available.");
  });

  it("shows a no data empty state when there are no accounts at all", () => {
    const markup = renderQuotaDetails({ error: false, loading: false, filteredAccounts: [], hasAnyAccounts: false });

    expect(markup).toContain("No quota account data available yet.");
    expect(markup).not.toContain("No accounts found for the selected filter.");
  });

  it("shows a no results empty state when filters exclude all accounts", () => {
    const markup = renderQuotaDetails({ error: false, loading: false, filteredAccounts: [], hasAnyAccounts: true });

    expect(markup).toContain("No accounts found for the selected filter.");
  });

  it("groups mixed Copilot aliases under a single shared provider label", () => {
    const markup = renderQuotaDetails({
      filteredAccounts: [
        {
          auth_index: "github-account",
          provider: "github",
          email: "github@example.com",
          supported: true,
          groups: [{ id: "daily", label: "Daily", remainingFraction: 0.8, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
        },
        {
          auth_index: "copilot-account",
          provider: "copilot",
          email: "copilot@example.com",
          supported: true,
          groups: [{ id: "daily", label: "Daily", remainingFraction: 0.7, resetTime: "2026-04-16T12:00:00.000Z", models: [] }],
        },
        {
          auth_index: "github-copilot-account",
          provider: "github-copilot",
          email: "gh-copilot@example.com",
          supported: true,
          monitorMode: "model-first",
          groups: [
            {
              id: "model-family",
              label: "Model Family",
              remainingFraction: 0.6,
              minRemainingFraction: 0.6,
              p50RemainingFraction: 0.7,
              resetTime: "2026-04-16T12:00:00.000Z",
              nextWindowResetAt: "2026-04-16T12:00:00.000Z",
              fullWindowResetAt: "2026-04-16T12:00:00.000Z",
              nextRecoveryAt: "2026-04-16T12:00:00.000Z",
              monitorMode: "model-first",
              models: [{ id: "gpt-4o", displayName: "GPT-4o", remainingFraction: 0.6, resetTime: "2026-04-16T12:00:00.000Z" }],
              totalModelCount: 1,
              readyModelCount: 1,
              effectiveReadyModelCount: 1,
              bottleneckModel: "gpt-4o",
            },
          ],
        },
      ],
      modelFirstOnlyView: false,
    });

    expect(markup).toContain(">Copilot</h3>");
    expect(markup).not.toContain(">Github<");
    expect(markup).not.toContain(">Github<");
    expect((markup.match(/>Copilot</g) ?? [])).toHaveLength(5);
  });
});
