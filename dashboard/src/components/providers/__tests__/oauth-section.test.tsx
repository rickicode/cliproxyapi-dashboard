import { describe, expect, it } from "vitest";
import enMessages from "../../../../messages/en.json";
import {
  getOAuthConnectSuccessFeedback,
  type OAuthAutoClaimResult,
} from "@/components/providers/oauth-section";

function t(key: string, values?: Record<string, string | number>) {
  const message = (enMessages.providers as Record<string, string>)[key];
  if (!message) {
    throw new Error(`Missing message for key: ${key}`);
  }

  return Object.entries(values ?? {}).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    message
  );
}

describe("getOAuthConnectSuccessFeedback", () => {
  it("shows default success feedback when auto-claim result is missing", () => {
    const feedback = getOAuthConnectSuccessFeedback(undefined, t);

    expect(feedback.toastMessage).toBe("OAuth account connected");
    expect(feedback.detailMessage).toBe("OAuth account connected successfully.");
    expect(feedback.strongClaimSuccess).toBe(false);
  });

  it("shows partial-success feedback when connect succeeds but auto-claim has no match", () => {
    const feedback = getOAuthConnectSuccessFeedback({ kind: "no_match" }, t);

    expect(feedback.toastMessage).toBe(
      "OAuth account connected. We couldn't identify the new account to claim automatically."
    );
    expect(feedback.detailMessage).toBe(
      "Connected successfully, but we couldn't identify the new account to claim automatically. You can claim it from Connected Accounts."
    );
    expect(feedback.strongClaimSuccess).toBe(false);
  });

  it("shows differentiated feedback for another non-claimed success outcome", () => {
    const autoClaim: OAuthAutoClaimResult = {
      kind: "claimed_by_other_user",
      candidate: {
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-2",
        ownerUsername: "teammate",
      },
    };

    const feedback = getOAuthConnectSuccessFeedback(autoClaim, t);

    expect(feedback.toastMessage).toBe(
      "OAuth account connected. The matched account is already owned by teammate."
    );
    expect(feedback.detailMessage).toBe(
      "Connected successfully, but the matched account is already owned by teammate."
    );
    expect(feedback.strongClaimSuccess).toBe(false);
  });

  it("uses accountName fallback for claimed-by-other-user owner label when owner-specific fields are missing", () => {
    const autoClaim: OAuthAutoClaimResult = {
      kind: "claimed_by_other_user",
      candidate: {
        accountName: "claude-shared-account.json",
        accountEmail: "shared@example.com",
        ownerUserId: "user-2",
        ownerUsername: null,
      },
    };

    const feedback = getOAuthConnectSuccessFeedback(autoClaim, t);

    expect(feedback.toastMessage).toBe(
      "OAuth account connected. The matched account is already owned by claude-shared-account.json."
    );
    expect(feedback.detailMessage).toBe(
      "Connected successfully, but the matched account is already owned by claude-shared-account.json."
    );
    expect(feedback.strongClaimSuccess).toBe(false);
  });

  it("shows the strongest success feedback when connect and auto-claim both succeed", () => {
    const autoClaim: OAuthAutoClaimResult = {
      kind: "claimed",
      candidate: {
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-1",
        ownerUsername: null,
      },
    };

    const feedback = getOAuthConnectSuccessFeedback(autoClaim, t);

    expect(feedback.toastMessage).toBe("OAuth account connected and claimed successfully");
    expect(feedback.detailMessage).toBe(
      "Connected successfully and automatically claimed for your account."
    );
    expect(feedback.strongClaimSuccess).toBe(true);
  });

  it("shows differentiated feedback when the matched account was already owned by the current user", () => {
    const autoClaim: OAuthAutoClaimResult = {
      kind: "already_owned_by_current_user",
      candidate: {
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-1",
        ownerUsername: "current-user",
      },
    };

    const feedback = getOAuthConnectSuccessFeedback(autoClaim, t);

    expect(feedback.toastMessage).toBe(
      "OAuth account connected. This account was already yours."
    );
    expect(feedback.detailMessage).toBe(
      "Connected successfully. This account was already owned by you."
    );
    expect(feedback.strongClaimSuccess).toBe(false);
  });

  it("shows differentiated feedback when auto-claim finds multiple possible accounts", () => {
    const autoClaim: OAuthAutoClaimResult = {
      kind: "ambiguous",
      candidates: [
        {
          accountName: "claude-user-1.json",
          accountEmail: "user1@example.com",
        },
        {
          accountName: "claude-user-2.json",
          accountEmail: "user2@example.com",
        },
      ],
    };

    const feedback = getOAuthConnectSuccessFeedback(autoClaim, t);

    expect(feedback.toastMessage).toBe(
      "OAuth account connected. We found multiple possible accounts, so nothing was claimed automatically."
    );
    expect(feedback.detailMessage).toBe(
      "Connected successfully, but multiple possible accounts were found so we couldn't claim one automatically. You can claim the correct one from Connected Accounts."
    );
    expect(feedback.strongClaimSuccess).toBe(false);
  });

  it("shows differentiated feedback when auto-claim verification fails", () => {
    const autoClaim: OAuthAutoClaimResult = {
      kind: "error",
      failure: {
        code: "claim_check_failed",
        message: "Could not verify account ownership",
      },
    };

    const feedback = getOAuthConnectSuccessFeedback(autoClaim, t);

    expect(feedback.toastMessage).toBe(
      "OAuth account connected. We couldn't verify the auto-claim result."
    );
    expect(feedback.detailMessage).toBe(
      "Connected successfully, but we couldn't verify the auto-claim result. You may need to claim the account manually from Connected Accounts."
    );
    expect(feedback.strongClaimSuccess).toBe(false);
  });
});
