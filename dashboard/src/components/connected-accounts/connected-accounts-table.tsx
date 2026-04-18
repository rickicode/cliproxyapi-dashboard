"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { OAuthListItem } from "@/lib/providers/oauth-listing";

export function isConnectedAccountBulkActionable(item: OAuthListItem) {
  return item.actionKey.trim().length > 0 && (item.canToggle || item.canDelete);
}

export function getSelectableConnectedAccountsActionKeys(items: OAuthListItem[]) {
  return items.filter(isConnectedAccountBulkActionable).map((item) => item.actionKey);
}

interface ConnectedAccountsTableProps {
  items: OAuthListItem[];
  selectedActionKeys: string[];
  loadingActionKey: string | null;
  onToggleVisible: (checked: boolean) => void;
  onToggleRow: (actionKey: string, checked: boolean) => void;
  onRowAction: (item: OAuthListItem, action: "enable" | "disable" | "disconnect") => void;
}

export function ConnectedAccountsTable({
  items,
  selectedActionKeys,
  loadingActionKey,
  onToggleVisible,
  onToggleRow,
  onRowAction,
}: ConnectedAccountsTableProps) {
  const t = useTranslations("providers");
  const selectedSet = new Set(selectedActionKeys);
  const selectableActionKeys = getSelectableConnectedAccountsActionKeys(items);
  const allVisibleSelected =
    selectableActionKeys.length > 0 && selectableActionKeys.every((actionKey) => selectedSet.has(actionKey));

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-6 text-sm text-[var(--text-muted)]">
        {t("noAccountsConnected")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)]">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="border-b border-[var(--surface-border)]">
          <tr>
            <th className="w-10 p-3 text-left">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                aria-label={t("connectedAccountsSelectVisible")}
                onChange={(event) => onToggleVisible(event.target.checked)}
              />
            </th>
            <th className="p-3 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {t("tableHeaderProvider")}
            </th>
            <th className="p-3 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {t("connectedAccountsAccountColumn")}
            </th>
            <th className="p-3 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {t("tableHeaderStatus")}
            </th>
            <th className="p-3 text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {t("tableHeaderActions")}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isBulkActionable = isConnectedAccountBulkActionable(item);
            const isSelected = isBulkActionable && selectedSet.has(item.actionKey);
            const isLoading = loadingActionKey === item.actionKey;

            return (
              <tr key={item.rowKey} className="border-b border-[var(--surface-border)] last:border-b-0">
                <td className="p-3 align-top">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    aria-label={item.accountName}
                    disabled={!isBulkActionable}
                    onChange={(event) => onToggleRow(item.actionKey, event.target.checked)}
                  />
                </td>
                <td className="p-3 align-top">
                  <div className="font-medium text-[var(--text-primary)]">{item.provider}</div>
                </td>
                <td className="p-3 align-top">
                  <div className="font-medium text-[var(--text-primary)]">{item.accountName}</div>
                  {item.accountEmail ? (
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">{item.accountEmail}</div>
                  ) : null}
                </td>
                <td className="p-3 align-top text-[var(--text-secondary)]">{item.status}</td>
                <td className="p-3 align-top">
                  <div className="flex justify-end gap-2">
                    {item.canToggle ? (
                      <Button
                        variant="secondary"
                        className="px-2.5 py-1 text-xs"
                        disabled={isLoading}
                        onClick={() => onRowAction(item, item.status === "disabled" ? "enable" : "disable")}
                      >
                        {isLoading ? "..." : item.status === "disabled" ? t("enableButton") : t("disableButton")}
                      </Button>
                    ) : null}
                    {item.canDelete ? (
                      <Button
                        variant="danger"
                        className="px-2.5 py-1 text-xs"
                        disabled={isLoading}
                        onClick={() => onRowAction(item, "disconnect")}
                      >
                        {isLoading ? "..." : t("disconnectButton")}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
