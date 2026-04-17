import type { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type QuotaTestModel = {
  id: string;
  displayName?: string;
  remainingFraction?: number;
};

type QuotaTestGroup = {
  models: QuotaTestModel[];
};

type QuotaTestAccount = {
  email: string;
  groups: QuotaTestGroup[];
};

type QuotaTestResponse = {
  accounts: QuotaTestAccount[];
};

type MockJsonResponse<T = unknown> = {
  ok: boolean;
  json: () => Promise<T>;
  body: { cancel: ReturnType<typeof vi.fn> };
};

type MockJsonResponseResolver<T = unknown> = (value: MockJsonResponse<T>) => void;

vi.mock("@/lib/auth/session", () => ({
  verifySession: vi.fn(() => ({ userId: "test-user" })),
}));

vi.mock("@/lib/cache", () => ({
  quotaCache: { get: vi.fn(() => null), set: vi.fn() },
  CACHE_TTL: { QUOTA: 30_000 },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("@/lib/providers/management-api", () => ({
  syncOAuthAccountStatus: vi.fn(async () => ({ ok: true })),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.stubEnv("MANAGEMENT_API_KEY", "test-key");
vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://test:8317/v0/management");

describe("GET /api/quota - Gemini CLI support (issue #125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it("returns supported: true for gemini-cli accounts", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "gemini-cli",
          email: "test@gmail.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    const googleModelsResponse = {
      models: {
        "gemini-2.5-pro": {
          displayName: "Gemini 2.5 Pro",
          quotaInfo: {
            remainingFraction: 0.75,
            resetTime: "2026-03-08T00:00:00Z",
          },
        },
        "gemini-2.5-flash": {
          displayName: "Gemini 2.5 Flash",
          quotaInfo: {
            remainingFraction: 0.9,
            resetTime: "2026-03-08T00:00:00Z",
          },
        },
      },
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              cloudaicompanionProject: "test-project",
            },
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(googleModelsResponse),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);

    const account = data.accounts[0];
    expect(account.provider).toBe("gemini-cli");
    expect(account.supported).toBe(true);
    expect(account.groups).toBeDefined();
    expect(account.groups.length).toBeGreaterThan(0);
  });

  it("returns supported: true with error for gemini-cli auth failures", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "gemini-cli",
          email: "test@gmail.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              cloudaicompanionProject: "test-project",
            },
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    const account = data.accounts[0];
    expect(account.provider).toBe("gemini-cli");
    expect(account.supported).toBe(true);
    expect(account.error).toBeDefined();
  });

  it("handles the gemini provider the same as gemini-cli", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "gemini",
          email: "test@gmail.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    const googleModelsResponse = {
      models: {
        "gemini-2.5-flash": {
          displayName: "Gemini 2.5 Flash",
          quotaInfo: {
            remainingFraction: 0.5,
            resetTime: null,
          },
        },
      },
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              cloudaicompanionProject: "test-project",
            },
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(googleModelsResponse),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    const account = data.accounts[0];
    expect(account.supported).toBe(true);
    expect(account.groups).toBeDefined();
  });

  it("falls back to the next Antigravity quota endpoint and returns model-first metadata", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "antigravity",
          email: "test@gmail.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    const googleModelsResponse = {
      status_code: 200,
      body: {
        models: {
          "gemini-2.5-flash": {
            quotaInfo: {
              remainingFraction: 0.8,
              resetTime: "2026-03-08T05:00:00Z",
            },
          },
          "gemini-3-pro-high": {
            displayName: "Gemini 3 Pro High",
            quotaInfo: {
              remainingFraction: 0.4,
              resetTime: "2026-03-12T00:00:00Z",
            },
          },
        },
      },
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              cloudaicompanionProject: "test-project",
            },
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 429,
            body: {},
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(googleModelsResponse),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(data.accounts).toHaveLength(1);
    expect(data.generatedAt).toBeDefined();

    const account = data.accounts[0];
    expect(account.provider).toBe("antigravity");
    expect(account.monitorMode).toBe("model-first");
    expect(account.snapshotFetchedAt).toBeDefined();
    expect(account.snapshotSource).toContain("daily-cloudcode-pa.googleapis.com");
    expect(account.groups[0].monitorMode).toBe("model-first");
    expect(account.groups[0].nextWindowResetAt).toBeDefined();
    expect(account.groups[0].p50RemainingFraction).toBeDefined();
    expect(account.groups[0].models[0].displayName).toBe("Gemini 3 Pro High");
    expect(account.groups[1].models[0].displayName).toBe("gemini-2.5-flash");
  });

  it("passes project_id to fetchAvailableModels and treats missing remainingFraction as depleted", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "antigravity",
          email: "test@gmail.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              cloudaicompanionProject: "confident-arc-98xjk",
            },
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              models: {
                "claude-opus-4-6-thinking": {
                  displayName: "Claude Opus 4.6 (Thinking)",
                  quotaInfo: {
                    resetTime: "2026-04-07T20:18:24Z",
                  },
                },
                "gemini-3-flash": {
                  displayName: "Gemini 3 Flash",
                  quotaInfo: {
                    remainingFraction: 0.8,
                    resetTime: "2026-04-07T12:10:05Z",
                  },
                },
              },
            },
          }),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
    });
    const fetchQuotaCallBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(fetchQuotaCallBody.data).toBe("{\"project\":\"confident-arc-98xjk\"}");

    const account = data.accounts[0] as QuotaTestAccount;
    const models = account.groups.flatMap((group) => group.models);
    const claudeModel = models.find((model) => model.id === "claude-opus-4-6-thinking");
    const flashModel = models.find((model) => model.id === "gemini-3-flash");

    expect(claudeModel?.remainingFraction).toBe(0);
    expect(flashModel?.remainingFraction).toBe(0.8);
  });
});

describe("GET /api/quota - imported provider normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it("copilot provider returns supported: true", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "copilot",
          email: "user@github.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    const copilotApiCallResponse = {
      status_code: 200,
      body: {
        quota_snapshots: {
          premium_interactions: {
            unlimited: true,
          },
        },
        quota_reset_date_utc: "2026-04-01T00:00:00Z",
      },
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(copilotApiCallResponse),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);

    const account = data.accounts[0];
    expect(account.provider).toBe("copilot");
    expect(account.supported).toBe(true);
    expect(account.groups).toBeDefined();
  });

  it("returns a summary payload for view=summary without accounts", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          email: "summary@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 50,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota?view=summary", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(data.accounts).toBeUndefined();
    expect(data.providers).toBeDefined();
    expect(data.totals).toBeDefined();
  });

  it("builds summary requests without invoking the detail response builder", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          email: "summary-light@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 25,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    const routeModule = await import("./route");
    const detailSpy = vi.spyOn(routeModule.quotaRouteInternals, "buildQuotaDetailResponse");

    const response = await routeModule.GET(
      new Request("http://localhost/api/quota?view=summary", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(detailSpy).not.toHaveBeenCalled();
    expect(data.accounts).toBeUndefined();
    expect(data.providers).toBeDefined();
  });

  it("preserves auth-files order in detail responses when concurrent workers finish out of order", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          email: "first@example.com",
          disabled: false,
          status: "active",
        },
        {
          auth_index: 1,
          provider: "codex",
          email: "second@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    let resolveFirstQuotaCall: MockJsonResponseResolver | null = null;

    fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/auth-files")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(authFilesResponse),
          body: { cancel: vi.fn() },
        });
      }

      if (url.endsWith("/api-call")) {
        const requestBody = JSON.parse(String(init?.body));
        const authIndex = String(requestBody.auth_index);
        const quotaResponse = {
          ok: true,
          json: () =>
            Promise.resolve({
              status_code: 200,
              body: JSON.stringify({
                rate_limit: {
                  primary_window: {
                    limit_window_seconds: 300,
                    used_percent: authIndex === "0" ? 50 : 25,
                    reset_at: authIndex === "0" ? 1774039200 : 1774039300,
                  },
                },
              }),
            }),
          body: { cancel: vi.fn() },
        };

        if (authIndex === "0") {
          return new Promise<MockJsonResponse>((resolve) => {
            resolveFirstQuotaCall = resolve;
          });
        }

        return Promise.resolve(quotaResponse);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const { GET } = await import("./route");

    const responsePromise = GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );

    for (let attempt = 0; attempt < 10 && !resolveFirstQuotaCall; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!resolveFirstQuotaCall) {
      throw new Error("Expected first quota call to still be pending");
    }

    const resolvePendingQuotaCall = resolveFirstQuotaCall!;

    resolvePendingQuotaCall({
      ok: true,
      json: () =>
        Promise.resolve({
          status_code: 200,
          body: JSON.stringify({
            rate_limit: {
              primary_window: {
                limit_window_seconds: 300,
                used_percent: 50,
                reset_at: 1774039200,
              },
            },
          }),
        }),
      body: { cancel: vi.fn() },
    });

    const response = await responsePromise;
    const data = await response.json();

    expect(data.accounts).toHaveLength(2);
    expect((data as QuotaTestResponse).accounts.map((account) => account.email)).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
  });

  it("returns model-first warning entries for the summary top banner", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "antigravity",
          email: "banner@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              cloudaicompanionProject: "test-project",
            },
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: {
              models: {
                "gemini-2.5-pro": {
                  displayName: "Gemini 2.5 Pro",
                  quotaInfo: {
                    remainingFraction: 1,
                    resetTime: "2026-04-15T12:00:00Z",
                  },
                },
                "gemini-2.5-flash": {
                  displayName: "Gemini 2.5 Flash",
                  quotaInfo: {
                    remainingFraction: 1,
                    resetTime: "2026-04-15T12:30:00Z",
                  },
                },
              },
            },
          }),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota?view=summary", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(data.warnings).toEqual([{ provider: "antigravity", count: 1 }]);
  });

  it("keeps concurrent summary and detail requests isolated by view", async () => {
    const routeModule = await import("./route");
    type DetailResponse = Awaited<
      ReturnType<typeof routeModule.quotaRouteInternals.buildQuotaDetailResponse>
    >;
    type SummaryResponse = Awaited<
      ReturnType<typeof routeModule.quotaRouteInternals.buildQuotaSummaryResponse>
    >;

    let resolveDetail!: (value: DetailResponse) => void;
    let resolveSummary!: (value: SummaryResponse) => void;

    const detailBuilderPromise = new Promise<DetailResponse>((resolve) => {
      resolveDetail = resolve;
    });
    const summaryBuilderPromise = new Promise<SummaryResponse>((resolve) => {
      resolveSummary = resolve;
    });

    const detailSpy = vi
      .spyOn(routeModule.quotaRouteInternals, "buildQuotaDetailResponse")
      .mockImplementation(() => detailBuilderPromise);
    const summarySpy = vi
      .spyOn(routeModule.quotaRouteInternals, "buildQuotaSummaryResponse")
      .mockImplementation(() => summaryBuilderPromise);

    const detailPromise = routeModule.GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );

    let detailSettled = false;
    void detailPromise.then(() => {
      detailSettled = true;
    });

    const summaryPromise = routeModule.GET(
      new Request("http://localhost/api/quota?view=summary", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(detailSpy).toHaveBeenCalledTimes(1);
    expect(summarySpy).toHaveBeenCalledTimes(1);

    resolveSummary({
      providers: [
        {
          provider: "codex",
          monitorMode: "window-based",
          totalAccounts: 1,
          activeAccounts: 1,
          healthyAccounts: 1,
          errorAccounts: 0,
          windowCapacities: [],
          lowCapacity: false,
        },
      ],
      totals: { activeAccounts: 1, providerCount: 1, lowCapacityCount: 0 },
      warnings: [],
    });

    const summaryResponse = await summaryPromise;
    const summaryData = await summaryResponse.json();
    expect(summaryData.accounts).toBeUndefined();
    expect(summaryData.providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "codex" })])
    );
    expect(summaryData.totals).toEqual({
      activeAccounts: 1,
      providerCount: 1,
      lowCapacityCount: 0,
    });
    expect(detailSettled).toBe(false);

    resolveDetail({
      accounts: [
        {
          auth_index: "0",
          provider: "codex",
          email: "mixed@example.com",
          supported: true,
        },
      ],
    });

    const detailResponse = await detailPromise;
    const detailData = await detailResponse.json();

    expect(detailData.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "mixed@example.com" })])
    );
  });

  it("CLAUDE uppercase provider returns supported: true", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "CLAUDE",
          email: "user@anthropic.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(authFilesResponse),
      body: { cancel: vi.fn() },
    });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);

    const account = data.accounts[0];
    expect(account.provider).toBe("CLAUDE");
    expect(account.supported).toBe(true);
  });

  it("unknown providers remain unsupported", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "unknown-xyz",
          email: "user@unknown.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(authFilesResponse),
      body: { cancel: vi.fn() },
    });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);

    const account = data.accounts[0];
    expect(account.provider).toBe("unknown-xyz");
    expect(account.supported).toBe(false);
  });

  it("infers claude provider from claude-credential.json when provider is unknown", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "unknown",
          id: "claude-credential.json",
          name: "claude-credential.json",
          email: "unknown",
          disabled: false,
          status: "active",
        },
      ],
    };

    const claudeUsageResponse = {
      five_hour: { utilization: 0.1, resets_at: "2026-03-20T18:00:00Z" },
      seven_day: { utilization: 0.3, resets_at: "2026-03-25T18:00:00Z" },
      seven_day_sonnet: { utilization: 0.2, resets_at: "2026-03-24T18:00:00Z" },
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status_code: 200, body: claudeUsageResponse }),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);

    const account = data.accounts[0];
    expect(account.provider).toBe("claude");
    expect(account.supported).toBe(true);
    expect(account.email).toBe("claude-credential.json");
    expect(account.groups).toBeDefined();
    expect(account.groups.length).toBeGreaterThan(0);
  });

  it("infers codex provider from codex_user@example.com.json when provider is unknown", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "unknown",
          id: "codex_user@example.com.json",
          name: "codex_user@example.com.json",
          email: "unknown",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 50,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);
    const account = data.accounts[0];
    expect(account.provider).toBe("codex");
    expect(account.supported).toBe(true);
    expect(account.groups).toBeDefined();
    expect(account.groups.length).toBeGreaterThan(0);
  });

  it("shares one cold-cache aggregation promise across concurrent requests", async () => {
    let resolveAuthFiles: ((value: { ok: boolean; json: () => Promise<unknown>; body: { cancel: ReturnType<typeof vi.fn> } }) => void) | null = null;

    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAuthFiles = resolve;
        })
    );

    const { GET } = await import("./route");

    const requestA = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const requestB = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });

    const responsePromiseA = GET(requestA as unknown as NextRequest);
    const responsePromiseB = GET(requestB as unknown as NextRequest);

    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const resolvePendingAuthFiles =
      resolveAuthFiles as ((value: {
        ok: boolean;
        json: () => Promise<unknown>;
        body: { cancel: ReturnType<typeof vi.fn> };
      }) => void) | null;
    if (resolvePendingAuthFiles) {
      resolvePendingAuthFiles({
        ok: true,
        json: () =>
          Promise.resolve({
            files: [
              {
                auth_index: 0,
                provider: "unknown-xyz",
                email: "user@example.com",
                disabled: false,
                status: "active",
              },
            ],
          }),
        body: { cancel: vi.fn() },
      });
    }

    const [responseA, responseB] = await Promise.all([responsePromiseA, responsePromiseB]);
    const [dataA, dataB] = await Promise.all([responseA.json(), responseB.json()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dataA).toEqual(dataB);
    expect(dataA.accounts).toHaveLength(1);
    expect(dataA.accounts[0]).toMatchObject({
      provider: "unknown-xyz",
      supported: false,
    });
  });

  it("logs quota timing breakdown with Codex-heavy provider counts", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          email: "codex-a@example.com",
          disabled: false,
          status: "active",
        },
        {
          auth_index: 1,
          provider: "codex",
          email: "codex-b@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 50,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    const loggerModule = await import("@/lib/logger");
    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(2);
    expect(loggerModule.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        totalAccounts: 2,
        providerBreakdown: expect.objectContaining({
          codex: expect.objectContaining({
            accountCount: 2,
          }),
        }),
      }),
      "Quota aggregation completed"
    );
  });

  it("warns for slow Codex quota checks with account context", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          email: "slow-codex@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 50,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(1_250)
      .mockReturnValueOnce(1_300);

    const loggerModule = await import("@/lib/logger");
    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);
    expect(loggerModule.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        auth_index: "0",
        accountIdentifier: "slow-codex@example.com",
        durationMs: 1240,
        slowThresholdMs: 1000,
        hasError: false,
      }),
      "Codex quota check was slow"
    );
  });

  it("warns for Codex quota check errors even when not slow", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          email: "error-codex@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.resolve({}),
        body: { cancel: vi.fn() },
      });

    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(140);

    const loggerModule = await import("@/lib/logger");
    const { GET } = await import("./route");

    const request = new Request("http://localhost/api/quota", {
      headers: { cookie: "session=test" },
    });
    const response = await GET(request as unknown as NextRequest);
    const data = await response.json();

    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].error).toContain("Cannot reach chatgpt.com");
    expect(loggerModule.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        auth_index: "0",
        accountIdentifier: "error-codex@example.com",
        durationMs: 100,
        slowThresholdMs: 1000,
        hasError: true,
      }),
      "Codex quota check failed"
    );
  });

  it("syncs Codex 401 results upstream and preserves the quota error text", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-401@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 401,
            body: JSON.stringify({ detail: "token expired" }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(data.accounts[0].error).toBe("Codex OAuth token expired - re-authenticate in CLIProxyAPI");
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledWith({
      accountName: "codex-account",
      provider: "codex",
      status: "error",
      statusMessage: "Codex OAuth token expired - re-authenticate in CLIProxyAPI",
      unavailable: true,
    });
  });

  it("syncs Codex 403 results upstream with a conservative unavailable status", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-403@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 403,
            body: JSON.stringify({ detail: "needs verification" }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(data.accounts[0].error).toBe("Codex access denied - account may need verification");
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledWith({
      accountName: "codex-account",
      provider: "codex",
      status: "error",
      statusMessage: "Codex access denied - account may need verification",
      unavailable: true,
    });
  });

  it("does not suppress retries after a failed Codex status sync attempt", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-retry@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 401,
            body: JSON.stringify({ detail: "token expired" }),
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 401,
            body: JSON.stringify({ detail: "token expired" }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");
    vi.mocked(managementApiModule.syncOAuthAccountStatus)
      .mockRejectedValueOnce(new Error("sync exploded"))
      .mockResolvedValueOnce({ ok: true });

    const { GET } = await import("./route");

    const firstResponse = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const firstData = await firstResponse.json();

    const secondResponse = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const secondData = await secondResponse.json();

    expect(firstData.accounts[0].error).toBe("Codex OAuth token expired - re-authenticate in CLIProxyAPI");
    expect(secondData.accounts[0].error).toBe("Codex OAuth token expired - re-authenticate in CLIProxyAPI");
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledTimes(2);
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenNthCalledWith(1, {
      accountName: "codex-account",
      provider: "codex",
      status: "error",
      statusMessage: "Codex OAuth token expired - re-authenticate in CLIProxyAPI",
      unavailable: true,
    });
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenNthCalledWith(2, {
      accountName: "codex-account",
      provider: "codex",
      status: "error",
      statusMessage: "Codex OAuth token expired - re-authenticate in CLIProxyAPI",
      unavailable: true,
    });
  });

  it("dedupes overlapping identical Codex sync attempts to a single upstream call", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-concurrent@example.com",
          disabled: false,
          status: "error",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 25,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 25,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");

    let resolveSync: ((value: { ok: true }) => void) | undefined;
    const syncPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSync = resolve;
    });
    vi.mocked(managementApiModule.syncOAuthAccountStatus).mockReturnValue(syncPromise);

    const { GET } = await import("./route");

    const firstResponsePromise = GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const secondResponsePromise = GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );

    await vi.waitFor(() => {
      expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledTimes(1);
    });

    resolveSync?.({ ok: true });

    const [firstResponse, secondResponse] = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    await expect(firstResponse.json()).resolves.toMatchObject({
      accounts: [
        {
          provider: "codex",
          groups: expect.any(Array),
        },
      ],
    });
    await expect(secondResponse.json()).resolves.toMatchObject({
      accounts: [
        {
          provider: "codex",
          groups: expect.any(Array),
        },
      ],
    });

    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledTimes(1);
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledWith({
      accountName: "codex-account",
      provider: "codex",
      status: "active",
      statusMessage: null,
      unavailable: false,
    });
  });

  it("syncs successful Codex quota checks back to active and available", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-success@example.com",
          disabled: false,
          status: "error",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 25,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(data.accounts[0].error).toBeUndefined();
    expect(data.accounts[0].groups).toBeDefined();
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledWith({
      accountName: "codex-account",
      provider: "codex",
      status: "active",
      statusMessage: null,
      unavailable: false,
    });
  });

  it("dedupes repeated successful Codex recovery syncs inside the window and retries after expiry", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-dedupe@example.com",
          disabled: false,
          status: "error",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 25,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 25,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 200,
            body: JSON.stringify({
              rate_limit: {
                primary_window: {
                  limit_window_seconds: 300,
                  used_percent: 25,
                  reset_at: 1774039200,
                },
              },
            }),
          }),
        body: { cancel: vi.fn() },
      });

    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_005)
      .mockReturnValueOnce(20_000)
      .mockReturnValueOnce(31_100)
      .mockReturnValueOnce(31_105);

    const managementApiModule = await import("@/lib/providers/management-api");
    const { GET } = await import("./route");

    const firstResponse = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const secondResponse = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const thirdResponse = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );

    await expect(firstResponse.json()).resolves.toMatchObject({
      accounts: [
        {
          provider: "codex",
          groups: expect.any(Array),
        },
      ],
    });
    await expect(secondResponse.json()).resolves.toMatchObject({
      accounts: [
        {
          provider: "codex",
          groups: expect.any(Array),
        },
      ],
    });
    await expect(thirdResponse.json()).resolves.toMatchObject({
      accounts: [
        {
          provider: "codex",
          groups: expect.any(Array),
        },
      ],
    });

    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenCalledTimes(2);
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenNthCalledWith(1, {
      accountName: "codex-account",
      provider: "codex",
      status: "active",
      statusMessage: null,
      unavailable: false,
    });
    expect(managementApiModule.syncOAuthAccountStatus).toHaveBeenNthCalledWith(2, {
      accountName: "codex-account",
      provider: "codex",
      status: "active",
      statusMessage: null,
      unavailable: false,
    });

    dateNowSpy.mockRestore();
  });

  it("continues quota handling when Codex status sync throws", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-401@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 401,
            body: JSON.stringify({ detail: "token expired" }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");
    const loggerModule = await import("@/lib/logger");
    vi.mocked(managementApiModule.syncOAuthAccountStatus).mockRejectedValueOnce(
      new Error("sync exploded")
    );

    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(data.accounts[0].error).toBe("Codex OAuth token expired - re-authenticate in CLIProxyAPI");
    expect(loggerModule.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        auth_index: "0",
        accountName: "codex-account",
        error: expect.any(Error),
      }),
      "Failed to sync Codex OAuth account status from quota outcome"
    );
  });

  it("continues quota handling when Codex status sync returns a non-ok result", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-403@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 403,
            body: JSON.stringify({ detail: "needs verification" }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");
    const loggerModule = await import("@/lib/logger");
    vi.mocked(managementApiModule.syncOAuthAccountStatus).mockResolvedValueOnce({
      ok: false,
      error: "management api unavailable",
    });

    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.accounts[0].error).toBe("Codex access denied - account may need verification");
    expect(loggerModule.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        auth_index: "0",
        accountName: "codex-account",
        error: "management api unavailable",
      }),
      "Failed to sync Codex OAuth account status from quota outcome"
    );
  });

  it("does not sync generic Codex failures upstream", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          name: "codex-account",
          email: "codex-500@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(authFilesResponse),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status_code: 500,
            body: JSON.stringify({ detail: "upstream exploded" }),
          }),
        body: { cancel: vi.fn() },
      });

    const managementApiModule = await import("@/lib/providers/management-api");
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as unknown as NextRequest
    );
    const data = await response.json();

    expect(data.accounts[0].error).toBe("Codex API error: 500 - upstream exploded");
    expect(managementApiModule.syncOAuthAccountStatus).not.toHaveBeenCalled();
  });
});
