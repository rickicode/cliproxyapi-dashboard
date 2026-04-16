import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../messages/en.json";
import {
  OAuthCredentialList,
  type OAuthAccountWithOwnership,
} from "@/components/providers/oauth-credential-list";

const noop = vi.fn();

function renderComponent(accounts: OAuthAccountWithOwnership[], currentUser: { isAdmin: boolean } | null = null) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <OAuthCredentialList
        accounts={accounts}
        loading={false}
        currentUser={currentUser ? { id: "user-1", username: "ricki", ...currentUser } : null}
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
  it("replaces action button ellipses with translated loading labels", () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <OAuthCredentialList
          accounts={[
            {
              id: "account-0",
              accountName: "claimable.json",
              accountEmail: "claimable@example.com",
              provider: "Claude Code",
              ownerUsername: null,
              ownerUserId: null,
              isOwn: false,
              status: "disabled",
              statusMessage: null,
              unavailable: false,
            },
          ]}
          loading={false}
          currentUser={{ id: "admin-1", username: "ricki", isAdmin: true }}
          togglingAccountId="account-0"
          claimingAccountName="claimable.json"
          onToggle={noop}
          onDelete={noop}
          onClaim={noop}
        />
      </NextIntlClientProvider>
    );

    expect(markup).not.toContain(">...<");
    expect(markup).toContain("Claiming...");
    expect(markup).toContain("Updating...");
  });

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

  it("shows Claim for admin users when ownerUserId is missing even if ownerUsername is present", () => {
    const markup = renderComponent(
      [
        {
          id: "account-2",
          accountName: "claimable.json",
          accountEmail: "claimable@example.com",
          provider: "Claude Code",
          ownerUsername: "stale-name",
          ownerUserId: null,
          isOwn: false,
          status: "active",
          statusMessage: null,
          unavailable: false,
        },
      ],
      { isAdmin: true }
    );

    expect(markup).toContain("Claim");
  });

  it("hides Claim for admin users when ownerUserId is present even if ownerUsername is missing", () => {
    const markup = renderComponent(
      [
        {
          id: "account-3",
          accountName: "owned.json",
          accountEmail: "owned@example.com",
          provider: "Claude Code",
          ownerUsername: null,
          ownerUserId: "user-2",
          isOwn: false,
          status: "active",
          statusMessage: null,
          unavailable: false,
        },
      ],
      { isAdmin: true }
    );

    expect(markup).not.toContain("Claim");
  });
});
