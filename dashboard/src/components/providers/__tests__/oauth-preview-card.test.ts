import { describe, expect, it } from "vitest";
import enMessages from "../../../../messages/en.json";
import {
  claimOAuthPreviewAccount,
  fetchOAuthPreview,
  getNextOAuthPreviewState,
} from "@/components/providers/oauth-preview-card";

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OAuthPreviewCard helpers", () => {
  it("returns parsed preview items and total on success", async () => {
    const account = {
      id: "oauth-1",
      accountName: "claude-user.json",
      accountEmail: "user@example.com",
      provider: "Claude Code",
      ownerUsername: "ricki",
      ownerUserId: "user-1",
      isOwn: true,
      status: "active",
      statusMessage: null,
      unavailable: false,
    };

    const result = await fetchOAuthPreview(
      (async (input: string | URL | Request) => {
        expect(String(input)).toBe("/api/providers/oauth?preview=true&page=1&pageSize=10");

        return jsonResponse({
          data: {
            items: [account],
            total: 4,
          },
        });
      }) as typeof fetch,
      t
    );

    expect(result).toEqual({
      ok: true,
      state: {
        accounts: [account],
        total: 4,
      },
    });
  });

  it("preserves the last successful preview state when refresh fails", () => {
    const previousState = {
      accounts: [
        {
          id: "oauth-1",
          accountName: "claude-user.json",
          accountEmail: "user@example.com",
          provider: "Claude Code",
          ownerUsername: "ricki",
          ownerUserId: "user-1",
          isOwn: true,
          status: "active",
          statusMessage: null,
          unavailable: false,
        },
      ],
      total: 3,
    };

    const nextState = getNextOAuthPreviewState(previousState, {
      ok: false,
      errorMessage: t("toastOAuthLoadFailed"),
    });

    expect(nextState).toBe(previousState);
    expect(nextState.total).toBe(3);
    expect(nextState.accounts).toHaveLength(1);
  });

  it("returns the backend claim failure message for toast display", async () => {
    const result = await claimOAuthPreviewAccount(
      "claude-user.json",
      (async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("/api/providers/oauth/claim");
        expect(init).toMatchObject({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountName: "claude-user.json" }),
        });

        return jsonResponse({ error: "Already claimed by another user" }, 409);
      }) as typeof fetch,
      t
    );

    expect(result).toEqual({
      ok: false,
      errorMessage: "Already claimed by another user",
    });
  });

  it("falls back to the existing load-failed translation on preview refresh error", async () => {
    const result = await fetchOAuthPreview(
      (async () => {
        throw new Error("network down");
      }) as typeof fetch,
      t
    );

    expect(result).toEqual({
      ok: false,
      errorMessage: "Failed to load OAuth accounts",
    });
  });
});
