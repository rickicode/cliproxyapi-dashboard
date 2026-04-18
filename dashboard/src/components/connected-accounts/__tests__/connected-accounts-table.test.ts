import { describe, expect, it } from "vitest";
import type { OAuthListItem } from "@/lib/providers/oauth-listing";
import * as tableModule from "@/components/connected-accounts/connected-accounts-table";

const getSelectableConnectedAccountsActionKeys = (
  tableModule as unknown as {
    getSelectableConnectedAccountsActionKeys?: (items: OAuthListItem[]) => string[];
  }
).getSelectableConnectedAccountsActionKeys;

function createItem(overrides: Partial<OAuthListItem>): OAuthListItem {
  return {
    id: overrides.id ?? "oauth-1",
    rowKey: overrides.rowKey ?? overrides.id ?? "oauth-1",
    actionKey: overrides.actionKey ?? overrides.id ?? "oauth-1",
    accountName: overrides.accountName ?? "account.json",
    accountEmail: overrides.accountEmail ?? "account@example.com",
    provider: overrides.provider ?? "Claude",
    ownerUsername: overrides.ownerUsername ?? "ricki",
    ownerUserId: overrides.ownerUserId ?? "user-1",
    isOwn: overrides.isOwn ?? true,
    status: overrides.status ?? "active",
    statusMessage: overrides.statusMessage ?? null,
    unavailable: overrides.unavailable ?? false,
    canToggle: overrides.canToggle ?? false,
    canDelete: overrides.canDelete ?? false,
    canClaim: overrides.canClaim ?? false,
  };
}

describe("Connected Accounts table helpers", () => {
  it("returns only bulk-actionable action keys for visible rows", () => {
    expect(getSelectableConnectedAccountsActionKeys).toBeTypeOf("function");

    const selectableActionKeys = getSelectableConnectedAccountsActionKeys?.([
      createItem({ id: "toggleable", actionKey: "toggleable", canToggle: true }),
      createItem({ id: "deletable", actionKey: "deletable", canDelete: true }),
      createItem({ id: "empty-key", actionKey: "", canToggle: true }),
      createItem({ id: "no-actions", actionKey: "no-actions" }),
      createItem({ id: "claim-only", actionKey: "claim-only", canClaim: true }),
    ]);

    expect(selectableActionKeys).toEqual(["toggleable", "deletable"]);
  });
});
