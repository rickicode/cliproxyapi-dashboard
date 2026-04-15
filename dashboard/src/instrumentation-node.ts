/**
 * Node.js-only instrumentation — imported conditionally from instrumentation.ts.
 * Starts the quota alert scheduler and usage collector scheduler.
 * The quota check interval and alert cooldown are read from DB settings.
 */

import { runAlertCheck, getCheckIntervalMs } from "@/lib/quota-alerts";
import { resyncCustomProviders } from "@/lib/providers/resync";
import { runUsageCollector } from "@/lib/usage/collector";
import { logger } from "@/lib/logger";

// Idempotency guard for HMR in dev — prevents duplicate intervals
const globalForScheduler = globalThis as typeof globalThis & {
  __quotaSchedulerRegistered?: boolean;
  __usageCollectorSchedulerRegistered?: boolean;
};

const USAGE_COLLECTOR_STARTUP_DELAY_MS = 60_000;
const DEFAULT_USAGE_COLLECTOR_INTERVAL_MS = 5 * 60 * 1000;

function scheduleTimeout(callback: () => void | Promise<void>, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function getNextUsageCollectorRunTime(fromMs: number, firstRunMs: number) {
  if (fromMs < firstRunMs) {
    return firstRunMs;
  }

  const elapsedSinceFirstRunMs = fromMs - firstRunMs;
  const intervalsElapsed = Math.floor(elapsedSinceFirstRunMs / DEFAULT_USAGE_COLLECTOR_INTERVAL_MS) + 1;

  return firstRunMs + intervalsElapsed * DEFAULT_USAGE_COLLECTOR_INTERVAL_MS;
}

export function registerNodeInstrumentation() {
  if (globalForScheduler.__quotaSchedulerRegistered) return;
  globalForScheduler.__quotaSchedulerRegistered = true;

  // Delay start to let the server fully initialize
  const STARTUP_DELAY_MS = 30_000; // 30 seconds

  scheduleTimeout(() => {
    startQuotaAlertScheduler();
  }, STARTUP_DELAY_MS);

  startUsageCollectorScheduler();

  scheduleTimeout(() => {
    resyncCustomProviders().catch((err) => {
      logger.error({ err }, "Startup custom provider resync failed");
    });
  }, 15_000);
}

function startUsageCollectorScheduler() {
  if (globalForScheduler.__usageCollectorSchedulerRegistered) return;
  globalForScheduler.__usageCollectorSchedulerRegistered = true;

  let isRunning = false;

  const run = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      await runUsageCollector({ trigger: "scheduler" });
    } catch (error) {
      logger.error({ error }, "Usage collector scheduler error");
    } finally {
      isRunning = false;
    }
  };

  const firstRunMs = Date.now() + USAGE_COLLECTOR_STARTUP_DELAY_MS;

  const scheduleNext = (scheduledStartMs: number) => {
    const delayMs = Math.max(0, scheduledStartMs - Date.now());

    scheduleTimeout(async () => {
      await run();

      const nextScheduledStartMs = getNextUsageCollectorRunTime(Date.now(), firstRunMs);
      scheduleNext(nextScheduledStartMs);
    }, delayMs);
  };

  scheduleNext(firstRunMs);
}

function startQuotaAlertScheduler() {
  let isRunning = false;

  const run = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const managementKey = process.env.MANAGEMENT_API_KEY;
      if (!managementKey) {
        logger.warn("Quota alert scheduler: MANAGEMENT_API_KEY not set, skipping");
        return;
      }

      const port = process.env.PORT ?? "8318";
      const baseUrl = process.env.NEXTAUTH_URL ?? process.env.DASHBOARD_URL ?? `http://localhost:${port}`;

      const quotaFetcher = async () => {
        try {
          const res = await fetch(`${baseUrl}/api/quota`, {
            headers: { "X-Internal-Key": managementKey },
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) return null;
          return res.json();
        } catch {
          return null;
        }
      };

      const result = await runAlertCheck(quotaFetcher, baseUrl);

      if (result.alertsSent && result.alertsSent > 0) {
        logger.info(
          { alertsSent: result.alertsSent },
          "Scheduled quota alert check: alerts sent"
        );
      }
    } catch (error) {
      // Log but never crash — scheduler errors must not take down the server
      logger.error({ error }, "Quota alert scheduler error");
    } finally {
      isRunning = false;
    }
  };

  // Use recursive setTimeout so interval can be re-read from DB each cycle
  const scheduleNext = async () => {
    await run();
    try {
      const intervalMs = await getCheckIntervalMs();
      scheduleTimeout(scheduleNext, intervalMs);
    } catch {
      // Fallback to 5 minutes if DB read fails
      scheduleTimeout(scheduleNext, 5 * 60 * 1000);
    }
  };

  scheduleNext();
}
