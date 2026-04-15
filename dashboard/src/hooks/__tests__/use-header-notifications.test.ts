import { describe, it, expect } from "vitest";
import { filterNotifications } from "@/lib/notification-dismissal";
import { buildNotifications } from "@/hooks/notification-utils";
import type { HealthStatus, QuotaAccount, UpdateCheckResult, TranslationFn } from "@/hooks/notification-utils";

const NOW = 1000000;
// Returns the key so assertions on IDs still pass; titles/messages are not tested here.
const t: TranslationFn = (key) => key;

const healthBothError: HealthStatus = { status: "degraded", database: "error", proxy: "error" };
const healthDbError: HealthStatus = { status: "degraded", database: "error", proxy: "connected" };
const healthProxyError: HealthStatus = { status: "degraded", database: "connected", proxy: "error" };
const healthOk: HealthStatus = { status: "ok", database: "connected", proxy: "connected" };

const accountWithCriticalQuota: QuotaAccount = {
  auth_index: "0",
  provider: "claude",
  email: "user@example.com",
  supported: true,
  groups: [{ id: "5h-session", label: "5h Session", remainingFraction: 0.02 }],
};

const accountWithWarnQuota: QuotaAccount = {
  auth_index: "1",
  provider: "gemini",
  email: "user@example.com",
  supported: true,
  groups: [{ id: "daily", label: "Daily Limit", remainingFraction: 0.15 }],
};

const proxyUpdate: UpdateCheckResult = {
  updateAvailable: true,
  latestVersion: "1.3.0",
  currentVersion: "1.2.3",
  buildInProgress: false,
};

const dashUpdate: UpdateCheckResult = {
  updateAvailable: true,
  latestVersion: "1.0.0",
  currentVersion: "0.9.0",
  buildInProgress: false,
};

describe("buildNotifications — deterministic IDs", () => {
  it("generates stable ID health-db when database is error", () => {
    const result = buildNotifications(healthDbError, null, null, null, t, NOW);
    const ids = result.map((n) => n.id);
    expect(ids).toContain("health-db");
  });

  it("generates stable ID health-proxy when proxy is error", () => {
    const result = buildNotifications(healthProxyError, null, null, null, t, NOW);
    const ids = result.map((n) => n.id);
    expect(ids).toContain("health-proxy");
  });

  it("generates stable ID for quota-critical notification", () => {
    const result = buildNotifications(healthOk, { accounts: [accountWithCriticalQuota] }, null, null, t, NOW);
    const ids = result.map((n) => n.id);
    expect(ids).toContain("quota-critical-claude-0-5h-session");
  });

  it("generates stable ID for quota-warn notification", () => {
    const result = buildNotifications(healthOk, { accounts: [accountWithWarnQuota] }, null, null, t, NOW);
    const ids = result.map((n) => n.id);
    expect(ids).toContain("quota-warn-gemini-1-daily");
  });

  it("generates stable ID update-proxy when proxy update available", () => {
    const result = buildNotifications(healthOk, null, proxyUpdate, null, t, NOW);
    const ids = result.map((n) => n.id);
    expect(ids).toContain("update-proxy");
  });

  it("generates stable ID update-dashboard when dashboard update available", () => {
    const result = buildNotifications(healthOk, null, null, dashUpdate, t, NOW);
    const ids = result.map((n) => n.id);
    expect(ids).toContain("update-dashboard");
  });

  it("generates stable IDs from quota summary warnings without detail accounts", () => {
    const result = buildNotifications(
      healthOk,
      {
        warnings: [
          { provider: "antigravity", count: 3 },
          { provider: "gemini", count: 1 },
        ],
      },
      null,
      null,
      t,
      NOW
    );

    expect(result.map((n) => n.id)).toEqual([
      "quota-summary-warning-antigravity",
      "quota-summary-warning-gemini",
    ]);
  });

  it("uses distinct summary warning semantics instead of quota-low titles", () => {
    const [notification] = buildNotifications(
      healthOk,
      {
        warnings: [{ provider: "antigravity", count: 2 }],
      },
      null,
      null,
      t,
      NOW
    );

    expect(notification).toMatchObject({
      id: "quota-summary-warning-antigravity",
      type: "warning",
      title: "quotaSummaryWarningTitle",
      message: "quotaSummaryMessage",
      link: "/dashboard/quota",
      timestamp: NOW,
    });
  });

  it("keeps detail-based low quota notifications for account groups", () => {
    const [notification] = buildNotifications(
      healthOk,
      { accounts: [accountWithWarnQuota] },
      null,
      null,
      t,
      NOW
    );

    expect(notification).toMatchObject({
      id: "quota-warn-gemini-1-daily",
      type: "warning",
      title: "quotaLowTitle",
      message: "quotaMessage",
      link: "/dashboard/quota",
      timestamp: NOW,
    });
  });

  it("creates low-capacity warning notifications from summary providers when detail accounts are unavailable", () => {
    const [notification] = buildNotifications(
      healthOk,
      {
        providers: [
          { provider: "copilot", lowCapacity: true },
          { provider: "claude", lowCapacity: false },
        ],
      },
      null,
      null,
      t,
      NOW
    );

    expect(notification).toMatchObject({
      id: "quota-summary-low-copilot",
      type: "warning",
      title: "quotaLowTitle",
      message: "quotaSummaryLowMessage",
      link: "/dashboard/quota",
      timestamp: NOW,
    });
  });

  it("IDs are identical across multiple calls with same inputs", () => {
    const inputs = [
      healthBothError,
      { accounts: [accountWithCriticalQuota, accountWithWarnQuota] },
      proxyUpdate,
      dashUpdate,
    ] as const;

    const first = buildNotifications(...inputs, t, NOW).map((n) => n.id);
    const second = buildNotifications(...inputs, t, NOW).map((n) => n.id);
    expect(first).toEqual(second);
  });
});

describe("buildNotifications — filtering dismissed IDs", () => {
  it("dismissed health-db ID filters out the notification (pure filtering test — PASSES)", () => {
    const notifications = buildNotifications(healthDbError, null, null, null, t, NOW);
    const dismissedIds = new Set(["health-db"]);
    const visible = notifications.filter((n) => !dismissedIds.has(n.id));
    expect(visible.length).toBe(notifications.length - 1);
  });

  it("dismissed quota-critical ID filters out critical notification from criticalCount (pure filtering test — PASSES)", () => {
    const notifications = buildNotifications(healthOk, { accounts: [accountWithCriticalQuota] }, null, null, t, NOW);
    const dismissedIds = new Set(["quota-critical-claude-0-5h-session"]);
    const visible = notifications.filter((n) => !dismissedIds.has(n.id));
    const criticalCount = visible.filter((n) => n.type === "critical").length;
    expect(criticalCount).toBe(0);
  });

  it("filterNotifications removes health-db from totalCount", () => {
    const notifications = buildNotifications(healthDbError, null, null, null, t, NOW);
    const visible = filterNotifications(notifications, new Set(["health-db"]));
    expect(visible.length).toBe(notifications.length - 1);
    expect(visible.find((n) => n.id === "health-db")).toBeUndefined();
  });

  it("filterNotifications removes dismissed critical from criticalCount", () => {
    const notifications = buildNotifications(healthOk, { accounts: [accountWithCriticalQuota] }, null, null, t, NOW);
    const visible = filterNotifications(
      notifications,
      new Set(["quota-critical-claude-0-5h-session"])
    );
    const criticalCount = visible.filter((n) => n.type === "critical").length;
    expect(criticalCount).toBe(0);
  });
});
