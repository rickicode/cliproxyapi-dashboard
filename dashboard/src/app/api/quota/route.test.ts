import { describe, it, expect, vi, beforeEach } from "vitest";

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

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.stubEnv("MANAGEMENT_API_KEY", "test-key");
vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://test:8317/v0/management");

describe("GET /api/quota - Gemini CLI support (issue #125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
    const data = await response.json();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
    });
    const fetchQuotaCallBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(fetchQuotaCallBody.data).toBe("{\"project\":\"confident-arc-98xjk\"}");

    const account = data.accounts[0];
    const models = account.groups.flatMap((group: any) => group.models);
    const claudeModel = models.find((model: any) => model.id === "claude-opus-4-6-thinking");
    const flashModel = models.find((model: any) => model.id === "gemini-3-flash");

    expect(claudeModel?.remainingFraction).toBe(0);
    expect(flashModel?.remainingFraction).toBe(0.8);
  });
});

describe("GET /api/quota - imported provider normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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
    const response = await GET(request as any);
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
      }) as any
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

    const routeModule = (await import("./route")) as any;
    const detailSpy = vi.spyOn(routeModule.quotaRouteInternals, "buildQuotaDetailResponse");

    const response = await routeModule.GET(
      new Request("http://localhost/api/quota?view=summary", {
        headers: { cookie: "session=test" },
      }) as any
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

    let resolveFirstQuotaCall: ((value: any) => void) | null = null;

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
          return new Promise((resolve: (value: any) => void) => {
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
      }) as any
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
    expect(data.accounts.map((account: any) => account.email)).toEqual([
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
      }) as any
    );
    const data = await response.json();

    expect(data.warnings).toEqual([{ provider: "antigravity", count: 1 }]);
  });

  it("keeps concurrent summary and detail requests isolated by view", async () => {
    const authFilesResponse = {
      files: [
        {
          auth_index: 0,
          provider: "codex",
          email: "mixed@example.com",
          disabled: false,
          status: "active",
        },
      ],
    };

    let authFilesCallCount = 0;
    let resolveFirstAuthFiles: ((value: any) => void) | null = null;

    fetchMock.mockImplementation((input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/auth-files")) {
        authFilesCallCount += 1;
        const currentAuthFilesCall = authFilesCallCount;

        if (currentAuthFilesCall === 1) {
          return new Promise((resolve: (value: any) => void) => {
            resolveFirstAuthFiles = resolve;
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(authFilesResponse),
          body: { cancel: vi.fn() },
        });
      }

      if (url.endsWith("/api-call")) {
        const currentAuthFilesCall = authFilesCallCount;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status_code: 200,
              body: JSON.stringify({
                rate_limit: {
                  primary_window: {
                    limit_window_seconds: 300,
                    used_percent: currentAuthFilesCall === 1 ? 50 : 25,
                    reset_at: currentAuthFilesCall === 1 ? 1774039200 : 1774039300,
                  },
                },
              }),
            }),
          body: { cancel: vi.fn() },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const { GET } = await import("./route");

    const detailPromise = GET(
      new Request("http://localhost/api/quota", {
        headers: { cookie: "session=test" },
      }) as any
    );

    const summaryPromise = GET(
      new Request("http://localhost/api/quota?view=summary", {
        headers: { cookie: "session=test" },
      }) as any
    );

    await Promise.resolve();
    await Promise.resolve();

    if (!resolveFirstAuthFiles) {
      throw new Error("Expected first auth-files request to be pending");
    }

    const resolvePendingAuthFiles: (value: any) => void = resolveFirstAuthFiles!;

    resolvePendingAuthFiles({
      ok: true,
      json: () => Promise.resolve(authFilesResponse),
      body: { cancel: vi.fn() },
    });

    const [detailResponse, summaryResponse] = await Promise.all([detailPromise, summaryPromise]);
    const detailData = await detailResponse.json();
    const summaryData = await summaryResponse.json();

    expect(detailData.accounts).toHaveLength(1);
    expect(summaryData.accounts).toBeUndefined();
    expect(summaryData.providers).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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

    const responsePromiseA = GET(requestA as any);
    const responsePromiseB = GET(requestB as any);

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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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
    const response = await GET(request as any);
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
});
