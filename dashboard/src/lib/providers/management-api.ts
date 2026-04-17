import "server-only";
import { env } from "@/lib/env";

/**
 * SINGLE-INSTANCE CONSTRAINT WARNING
 *
 * This AsyncMutex is IN-PROCESS ONLY and does NOT work across multiple dashboard instances.
 * It only synchronizes concurrent requests within a single Node.js process.
 *
 * Current deployment: Single-instance (sufficient for current architecture)
 * If multi-instance deployment is needed in the future: Replace with Postgres advisory locks
 * or a distributed locking mechanism (Redis Redlock, etc.)
 *
 * Per-provider async mutex to serialize GET-modify-PUT sequences.
 * Prevents race conditions where concurrent requests read the same state,
 * modify independently, and the last write overwrites the first.
 * In-process only — sufficient because dashboard runs as a single Node.js process.
 */
export class AsyncMutex {
  private locks = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let released = false;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(key, promise);
    return () => {
      if (released) return;
      released = true;
      if (this.locks.get(key) === promise) {
        this.locks.delete(key);
      }
      resolve();
    };
  }
}

export const providerMutex = new AsyncMutex();

export const MANAGEMENT_BASE_URL = env.CLIPROXYAPI_MANAGEMENT_URL;
export const MANAGEMENT_API_KEY = env.MANAGEMENT_API_KEY;
export const FETCH_TIMEOUT_MS = 10000; // 10 second timeout for all Management API calls

/**
 * Wrapper for fetch with timeout using AbortController.
 * Ensures requests don't hang indefinitely.
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}

export interface ContributeKeyResult {
  ok: boolean;
  keyHash?: string;
  keyIdentifier?: string;
  error?: string;
}

export interface RemoveKeyResult {
  ok: boolean;
  error?: string;
}

export interface KeyWithOwnership {
  keyHash: string;
  maskedKey: string;
  provider: string;
  ownerUsername: string | null;
  ownerUserId: string | null;
  isOwn: boolean;
}

export interface ListKeysResult {
  ok: boolean;
  keys?: KeyWithOwnership[];
  error?: string;
}

export interface OAuthAccountWithOwnership {
  id: string;
  accountName: string;
  accountEmail: string | null;
  provider: string;
  ownerUsername: string | null;
  ownerUserId: string | null;
  isOwn: boolean;
  status: "active" | "error" | "disabled" | string;
  statusMessage: string | null;
  unavailable: boolean;
}

export interface ListOAuthResult {
  ok: boolean;
  accounts?: OAuthAccountWithOwnership[];
  error?: string;
}

export interface ContributeOAuthResult {
  ok: boolean;
  id?: string;
  resolution?: "claimed" | "already_owned_by_current_user" | "merged_with_existing";
  error?: string;
}

export interface RemoveOAuthResult {
  ok: boolean;
  error?: string;
}

export interface ImportOAuthResult {
  ok: boolean;
  id?: string;
  accountName?: string;
  resolution?: "claimed" | "already_owned_by_current_user" | "merged_with_existing";
  error?: string;
}

export interface ToggleOAuthResult {
  ok: boolean;
  disabled?: boolean;
  error?: string;
}

export interface SyncOAuthAccountStatusInput {
  accountName: string;
  provider: string;
  status: string;
  statusMessage: string | null;
  unavailable: boolean;
}

export interface SyncOAuthAccountStatusResult {
  ok: boolean;
  error?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isApiKeyArray(value: unknown): value is Array<{ "api-key": string }> {
  if (!Array.isArray(value)) return false;
  return value.every((item) => isRecord(item) && typeof item["api-key"] === "string");
}

export function isOpenAICompatArray(
  value: unknown
): value is Array<{ name: string; "api-key-entries": Array<{ "api-key": string }> }> {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      isRecord(item) &&
      typeof item.name === "string" &&
      Array.isArray(item["api-key-entries"]) &&
      (item["api-key-entries"] as unknown[]).every(
        (entry) => isRecord(entry) && typeof entry["api-key"] === "string"
      )
  );
}

export async function syncOAuthAccountStatus(
  input: SyncOAuthAccountStatusInput
): Promise<SyncOAuthAccountStatusResult> {
  try {
    const response = await fetchWithTimeout(`${MANAGEMENT_BASE_URL}/auth-files/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": MANAGEMENT_API_KEY,
      },
      body: JSON.stringify({
        name: input.accountName,
        provider: input.provider,
        status: input.status,
        status_message: input.statusMessage,
        unavailable: input.unavailable,
      }),
    });

    if (!response.ok) {
      let responseText = "";

      try {
        responseText = await response.text();
      } catch {
        responseText = "";
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }

      const message = responseText
        ? `Management API auth-file status sync failed with HTTP ${response.status}: ${responseText}`
        : `Management API auth-file status sync failed with HTTP ${response.status}`;

      return { ok: false, error: message };
    }

    await response.body?.cancel().catch(() => undefined);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Management API auth-file status sync failed: ${message}`,
    };
  }
}
