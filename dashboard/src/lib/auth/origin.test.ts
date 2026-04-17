import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("validateOrigin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("rejects mutating requests without an Origin header", async () => {
    const { validateOrigin } = await import("./origin");
    const request = new NextRequest("https://dashboard.example.com/api/providers/oauth/import", {
      method: "POST",
    });

    const response = validateOrigin(request);

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("allows requests whose Origin matches the request URL origin directly", async () => {
    const { validateOrigin } = await import("./origin");
    const request = new NextRequest("https://dashboard.example.com/api/providers/oauth/import", {
      method: "POST",
      headers: {
        origin: "https://dashboard.example.com",
      },
    });

    expect(validateOrigin(request)).toBeNull();
  });

  it("allows requests whose Origin matches the configured dashboard origin", async () => {
    vi.stubEnv("DASHBOARD_URL", "https://dashboard.example.com");

    const { validateOrigin } = await import("./origin");
    const request = new NextRequest("https://internal.example.net/api/providers/oauth/import", {
      method: "POST",
      headers: {
        origin: "https://dashboard.example.com",
      },
    });

    expect(validateOrigin(request)).toBeNull();
  });

  it("rejects spoofed forwarded host and proto when the request URL origin does not match", async () => {
    const { validateOrigin } = await import("./origin");
    const request = new NextRequest("https://internal.example.net/api/providers/oauth/import", {
      method: "POST",
      headers: {
        origin: "https://dashboard.example.com",
        "x-forwarded-host": "dashboard.example.com",
        "x-forwarded-proto": "https",
      },
    });

    const response = validateOrigin(request);

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: "Forbidden" });
  });
});
