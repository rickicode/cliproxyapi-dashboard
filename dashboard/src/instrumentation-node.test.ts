import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAlertCheck = vi.fn();
const getCheckIntervalMs = vi.fn();
const resyncCustomProviders = vi.fn();
const runUsageCollector = vi.fn();
const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

vi.mock("@/lib/quota-alerts", () => ({
  runAlertCheck,
  getCheckIntervalMs,
}));

vi.mock("@/lib/providers/resync", () => ({
  resyncCustomProviders,
}));

vi.mock("@/lib/usage/collector", () => ({
  runUsageCollector,
}));

vi.mock("@/lib/logger", () => ({
  logger,
}));

type SchedulerGlobal = typeof globalThis & {
  __quotaSchedulerRegistered?: boolean;
  __usageCollectorSchedulerRegistered?: boolean;
};

const schedulerGlobal = globalThis as SchedulerGlobal;

async function importSubject() {
  return import("./instrumentation-node");
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("instrumentation-node", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();

    delete schedulerGlobal.__quotaSchedulerRegistered;
    delete schedulerGlobal.__usageCollectorSchedulerRegistered;

    runAlertCheck.mockResolvedValue({ alertsSent: 0 });
    getCheckIntervalMs.mockResolvedValue(60_000);
    resyncCustomProviders.mockResolvedValue(undefined);
    runUsageCollector.mockResolvedValue({ ok: true, skipped: false, runId: "run-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("registration guard prevents duplicate scheduler setup", async () => {
    const { registerNodeInstrumentation } = await importSubject();

    registerNodeInstrumentation();
    registerNodeInstrumentation();

    expect(vi.getTimerCount()).toBe(3);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runUsageCollector).toHaveBeenCalledTimes(1);
  });

  it("registers the usage scheduler from registerNodeInstrumentation", async () => {
    const { registerNodeInstrumentation } = await importSubject();

    registerNodeInstrumentation();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(runUsageCollector).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runUsageCollector).toHaveBeenCalledTimes(1);
  });

  it("invokes runUsageCollector with the scheduler trigger", async () => {
    const { registerNodeInstrumentation } = await importSubject();

    registerNodeInstrumentation();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runUsageCollector).toHaveBeenCalledWith({ trigger: "scheduler" });
  });

  it("keeps usage runs aligned to the fixed 5-minute cadence after a long run", async () => {
    let resolveRun: (() => void) | undefined;
    runUsageCollector.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = () => resolve({ ok: true, skipped: false, runId: "run-1" });
        })
    );

    const { registerNodeInstrumentation } = await importSubject();

    registerNodeInstrumentation();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(7 * 60 * 1000);
    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    expect(resolveRun).toBeTypeOf("function");
    resolveRun!();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 59_999);
    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runUsageCollector).toHaveBeenCalledTimes(2);
  });

  it("skips missed intervals after a 12-minute overrun and schedules only the next future run", async () => {
    let resolveRun: (() => void) | undefined;
    runUsageCollector.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = () => resolve({ ok: true, skipped: false, runId: "run-1" });
        })
    );

    const { registerNodeInstrumentation } = await importSubject();

    registerNodeInstrumentation();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12 * 60 * 1000);
    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    expect(resolveRun).toBeTypeOf("function");
    resolveRun!();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 59_999);
    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runUsageCollector).toHaveBeenCalledTimes(2);
  });

  it("logs errors and continues future runs", async () => {
    runUsageCollector
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, skipped: false, runId: "run-2" });

    const { registerNodeInstrumentation } = await importSubject();

    registerNodeInstrumentation();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(logger.error).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(runUsageCollector).toHaveBeenCalledTimes(2);
  });

  it("keeps scheduling after an already-running skip result", async () => {
    runUsageCollector
      .mockResolvedValueOnce({ ok: false, skipped: true, runId: "run-skip", reason: "collector-already-running" })
      .mockResolvedValueOnce({ ok: true, skipped: false, runId: "run-next" });

    const { registerNodeInstrumentation } = await importSubject();

    registerNodeInstrumentation();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runUsageCollector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(runUsageCollector).toHaveBeenCalledTimes(2);
  });
});
