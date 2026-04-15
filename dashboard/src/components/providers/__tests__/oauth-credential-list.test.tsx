import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../messages/en.json";
import {
  OAuthCredentialList,
  type OAuthAccountWithOwnership,
} from "@/components/providers/oauth-credential-list";

const noop = vi.fn();

function renderComponent(accounts: OAuthAccountWithOwnership[]) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <OAuthCredentialList
        accounts={accounts}
        loading={false}
        currentUser={null}
        togglingAccountId={null}
        claimingAccountName={null}
        onToggle={noop}
        onDelete={noop}
        onClaim={noop}
      />
    </NextIntlClientProvider>
  );
}

describe("OAuthCredentialList", () => {
  it("renders the raw upstream value for unknown account statuses", () => {
    const markup = renderComponent([
      {
        id: "account-1",
        accountName: "mystery-account.json",
        accountEmail: "mystery@example.com",
        provider: "Claude Code",
        ownerUsername: null,
        ownerUserId: null,
        isOwn: false,
        status: "mystery-status",
        statusMessage: null,
        unavailable: false,
      },
    ]);

    expect(markup).toContain("mystery-status");
  });
});
