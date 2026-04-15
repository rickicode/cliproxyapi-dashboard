import { describe, expect, it, vi } from "vitest";
import {
  buildConnectedAccountsSearch,
  createConnectedAccountsRuntime,
  loadConnectedAccountsPageData,
  submitConnectedAccountRowAction,
  type ConnectedAccountsQueryState,
} from "@/components/connected-accounts/connected-accounts-page";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseQuery: ConnectedAccountsQueryState = {
  q: "claude",
  status: "disabled",
  page: 3,
  pageSize: 25,
};

describe("Connected Accounts page helpers", () => {
  it("preserves query-string filters when refreshing after a row action", async () => {
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/providers/oauth/oauth-1") {
        expect(init).toMatchObject({
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: false }),
        });

        return jsonResponse({ success: true, disabled: false });
      }

      expect(url).toBe(
        "/api/providers/oauth?q=claude&status=disabled&page=3&pageSize=25"
      );

      return jsonResponse({
        success: true,
        data: {
          items: [
            {
              id: "oauth-1",
              actionKey: "oauth-1",
              accountName: "claude-1.json",
              accountEmail: "claude@example.com",
              provider: "Claude",
              ownerUsername: "ricki",
              ownerUserId: "user-1",
              isOwn: true,
              status: "active",
              statusMessage: null,
              unavailable: false,
              canToggle: true,
              canDelete: true,
              canClaim: false,
            },
          ],
          page: 3,
          pageSize: 25,
          total: 63,
          totalPages: 3,
          availableStatuses: ["active", "disabled"],
        },
      });
    };

    const result = await submitConnectedAccountRowAction({
      query: baseQuery,
      accountId: "oauth-1",
      action: "enable",
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.query).toEqual(baseQuery);
    expect(result.canonicalSearch).toBe("?q=claude&status=disabled&page=3&pageSize=25");
    expect(result.data.page).toBe(3);
  });

  it("falls back to the nearest valid page when current page exceeds totalPages", async () => {
    const result = await loadConnectedAccountsPageData({
      q: "codex",
      status: "active",
      page: 4,
      pageSize: 25,
      fetchImpl: (async (input: string | URL | Request) => {
        expect(String(input)).toBe(
          "/api/providers/oauth?q=codex&status=active&page=4&pageSize=25"
        );

        return jsonResponse({
          success: true,
          data: {
            items: [],
            page: 2,
            pageSize: 25,
            total: 40,
            totalPages: 2,
            availableStatuses: ["active", "disabled"],
          },
        });
      }) as typeof fetch,
    });

    expect(result.query).toEqual({
      q: "codex",
      status: "active",
      page: 2,
      pageSize: 25,
    });
    expect(result.canonicalSearch).toBe("?q=codex&status=active&page=2&pageSize=25");
  });

  it("passes through an abort signal for superseded list loads", async () => {
    const abortController = new AbortController();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(abortController.signal);

      return jsonResponse({
        success: true,
        data: {
          items: [],
          page: 1,
          pageSize: 25,
          total: 0,
          totalPages: 1,
          availableStatuses: ["active"],
        },
      });
    });

    await loadConnectedAccountsPageData({
      ...baseQuery,
      fetchImpl: fetchMock as typeof fetch,
      signal: abortController.signal,
    } as ConnectedAccountsQueryState & { fetchImpl?: typeof fetch; signal: AbortSignal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores stale older responses when a newer request is current", async () => {
    let latestRequestId = 2;
    const applied: string[] = [];
    const runtime = createConnectedAccountsRuntime({
      getLatestRequestId: () => latestRequestId,
    });

    const staleResult = {
      data: {
        items: [],
        page: 1,
        pageSize: 25,
        total: 1,
        totalPages: 1,
        availableStatuses: ["active"],
      },
      query: { q: "older", status: "active", page: 1, pageSize: 25 },
      canonicalSearch: buildConnectedAccountsSearch({
        q: "older",
        status: "active",
        page: 1,
        pageSize: 25,
      }),
    };

    const freshResult = {
      data: {
        items: [],
        page: 1,
        pageSize: 25,
        total: 2,
        totalPages: 1,
        availableStatuses: ["disabled"],
      },
      query: { q: "newer", status: "disabled", page: 1, pageSize: 25 },
      canonicalSearch: buildConnectedAccountsSearch({
        q: "newer",
        status: "disabled",
        page: 1,
        pageSize: 25,
      }),
    };

    runtime.applyResponse(1, staleResult, () => applied.push("stale-response"));
    runtime.applyError(1, () => applied.push("stale-error"));
    runtime.applyFinally(1, () => applied.push("stale-finally"));

    expect(applied).toEqual([]);

    latestRequestId = 2;
    runtime.applyResponse(2, freshResult, () => applied.push("fresh-response"));
    runtime.applyError(2, () => applied.push("fresh-error"));
    runtime.applyFinally(2, () => applied.push("fresh-finally"));

    expect(applied).toEqual(["fresh-response", "fresh-error", "fresh-finally"]);
  });
});
