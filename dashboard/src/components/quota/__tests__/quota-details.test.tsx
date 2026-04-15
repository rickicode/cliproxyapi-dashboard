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

  it("shows the empty state only after detail loading succeeds with no accounts", () => {
    const markup = renderQuotaDetails({ error: false, loading: false, filteredAccounts: [] });

    expect(markup).toContain("No accounts found for the selected filter.");
  });
});
