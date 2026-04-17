import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { promisify } from "util";

vi.mock("server-only", () => ({}));

const accessMock = vi.fn();
const readFileMock = vi.fn();
const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const findUniqueMock = vi.fn();
const execFileAsyncMock = vi.fn();
const execFileMock = Object.assign(vi.fn(), {
  [promisify.custom]: execFileAsyncMock,
});

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("fs/promises", () => ({
  access: accessMock,
  readFile: readFileMock,
}));

const defaultComposeEnv = [
  "DB_MODE=docker",
  "POSTGRES_PASSWORD=postgres-secret",
  "DATABASE_URL=postgresql://cliproxyapi:postgres-secret@postgres:5432/cliproxyapi",
  "MANAGEMENT_API_KEY=test-management-key",
  "JWT_SECRET=test-jwt-secret",
].join("\n");

describe("POST /api/update", () => {
  beforeEach(() => {
    vi.resetModules();
    verifySessionMock.mockReset();
    validateOriginMock.mockReset();
    findUniqueMock.mockReset();
    execFileAsyncMock.mockReset();
    execFileMock.mockClear();
    accessMock.mockReset();
    readFileMock.mockReset();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    findUniqueMock.mockResolvedValue({ isAdmin: true });
    accessMock.mockResolvedValue(undefined);
    readFileMock.mockResolvedValue(defaultComposeEnv);
  });

  it("prefers the compose recreate path when compose is available without requiring a container snapshot", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:known-good","Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "up-ok", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(response.status).toBe(200);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["compose", "version"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["inspect", "cliproxyapi"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      "docker",
      ["pull", "eceasy/cli-proxy-api-plus:latest"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      "docker",
      [
        "compose",
        "--env-file",
        "/opt/cliproxyapi/infrastructure/.env",
        "-f",
        "/opt/cliproxyapi/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ],
    );
    expect(execFileAsyncMock).toHaveBeenCalledTimes(4);
    expect(readFileMock).toHaveBeenCalledWith("/opt/cliproxyapi/infrastructure/.env", "utf8");
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "-d", "--name", "cliproxyapi"]),
    );
  });

  it("restores the prior compose latest image reference and force recreates recovery when a latest update fails", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:known-good","Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockRejectedValueOnce(new Error("compose failed"))
      .mockResolvedValueOnce({ stdout: "tag-restore", stderr: "" })
      .mockResolvedValueOnce({ stdout: "recover-ok", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );
    const body = await response.json();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["inspect", "cliproxyapi"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      "docker",
      ["pull", "eceasy/cli-proxy-api-plus:latest"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      "docker",
      [
        "compose",
        "--env-file",
        "/opt/cliproxyapi/infrastructure/.env",
        "-f",
        "/opt/cliproxyapi/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ]
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      5,
      "docker",
      ["tag", "sha256:known-good", "eceasy/cli-proxy-api-plus:latest"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      6,
      "docker",
      [
        "compose",
        "--env-file",
        "/opt/cliproxyapi/infrastructure/.env",
        "-f",
        "/opt/cliproxyapi/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ]
    );
    expect(execFileAsyncMock).toHaveBeenCalledTimes(6);
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      },
    });
  });

  it("restores the previous compose latest tag and force recreates bounded recovery for versioned updates", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:previous-latest","Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "tag-new-latest", stderr: "" })
      .mockRejectedValueOnce(new Error("compose failed"))
      .mockResolvedValueOnce({ stdout: "tag-restore", stderr: "" })
      .mockResolvedValueOnce({ stdout: "recover-ok", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "v1.2.3", confirm: true }),
      })
    );

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["inspect", "cliproxyapi"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      "docker",
      ["tag", "eceasy/cli-proxy-api-plus:v1.2.3", "eceasy/cli-proxy-api-plus:latest"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      6,
      "docker",
      ["tag", "sha256:previous-latest", "eceasy/cli-proxy-api-plus:latest"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      7,
      "docker",
      [
        "compose",
        "--env-file",
        "/opt/cliproxyapi/infrastructure/.env",
        "-f",
        "/opt/cliproxyapi/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ],
    );
    expect(response.status).toBe(500);
  });

  it("refuses versioned compose rollouts when no immutable latest reference exists and only restarts the container", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '{"RepoTags":["eceasy/cli-proxy-api-plus:latest"]}', stderr: "" })
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "v1.2.3", confirm: true }),
      })
    );

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "docker", ["inspect", "cliproxyapi"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(3, "docker", [
      "image",
      "inspect",
      "eceasy/cli-proxy-api-plus:latest",
      "--format",
      "{{json .}}",
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(4, "docker", ["start", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", [
      "tag",
      "eceasy/cli-proxy-api-plus:v1.2.3",
      "eceasy/cli-proxy-api-plus:latest",
    ]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", ["pull", "eceasy/cli-proxy-api-plus:v1.2.3"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", ["rm", "-f", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "-d", "--name", "cliproxyapi"]),
    );
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "compose",
        "--env-file",
        "/opt/cliproxyapi/infrastructure/.env",
        "-f",
        "/opt/cliproxyapi/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ]),
    );
    expect(response.status).toBe(500);
  });

  it("allows compose rollout validation in external DB mode without requiring POSTGRES_PASSWORD", async () => {
    readFileMock.mockResolvedValue([
      "DB_MODE=external",
      "DATABASE_URL=postgresql://external-user:external-pass@db.example.com:5432/cliproxyapi",
      "MANAGEMENT_API_KEY=test-management-key",
      "JWT_SECRET=test-jwt-secret",
    ].join("\n"));

    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:known-good","Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "up-ok", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(response.status).toBe(200);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(4);
  });

  it("accepts quoted DB_MODE and DATABASE_URL values in the compose env file", async () => {
    readFileMock.mockResolvedValue([
      'DB_MODE="docker"',
      'POSTGRES_PASSWORD="postgres-secret"',
      'DATABASE_URL="postgresql://cliproxyapi:postgres-secret@postgres:5432/cliproxyapi"',
      'MANAGEMENT_API_KEY="test-management-key"',
      'JWT_SECRET="test-jwt-secret"',
    ].join("\n"));

    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:known-good","Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "up-ok", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(response.status).toBe(200);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(4);
  });

  it("fails fast when docker DB mode is missing POSTGRES_PASSWORD in compose env", async () => {
    readFileMock.mockResolvedValue([
      "DB_MODE=docker",
      "DATABASE_URL=postgresql://cliproxyapi@postgres:5432/cliproxyapi",
      "MANAGEMENT_API_KEY=test-management-key",
      "JWT_SECRET=test-jwt-secret",
    ].join("\n"));

    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(response.status).toBe(500);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "docker", ["compose", "version"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "docker", ["start", "cliproxyapi"]);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns a clear config error when the mounted compose file is missing", async () => {
    accessMock.mockRejectedValueOnce(new Error("ENOENT"));
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "CONFIG_ERROR",
        message: "Update compose rollout requires mounted compose file at /opt/cliproxyapi/docker-compose.yml",
      },
    });
    expect(accessMock).toHaveBeenCalledTimes(1);
    expect(accessMock).toHaveBeenNthCalledWith(1, "/opt/cliproxyapi/docker-compose.yml");
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "docker", ["compose", "version"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "docker", ["start", "cliproxyapi"]);
  });

  it("returns a clear config error when the mounted compose env file is missing", async () => {
    accessMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ENOENT"));
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "CONFIG_ERROR",
        message: "Update compose rollout requires mounted compose env file at /opt/cliproxyapi/infrastructure/.env",
      },
    });
    expect(accessMock).toHaveBeenNthCalledWith(1, "/opt/cliproxyapi/docker-compose.yml");
    expect(accessMock).toHaveBeenNthCalledWith(2, "/opt/cliproxyapi/infrastructure/.env");
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "docker", ["compose", "version"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "docker", ["start", "cliproxyapi"]);
  });

  it("tries to start the existing proxy container if compose recovery also fails", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockRejectedValueOnce(new Error("compose failed"))
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      "docker",
      [
        "compose",
        "--env-file",
        "/opt/cliproxyapi/infrastructure/.env",
        "-f",
        "/opt/cliproxyapi/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ]
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      5,
      "docker",
      ["start", "cliproxyapi"]
    );
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["rm", "-f", "cliproxyapi"]),
    );
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "-d", "--name", "cliproxyapi"]),
    );
    expect(response.status).toBe(500);
  });

  it("does not attempt compose recreation rollback when only a mutable latest reference is available", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockRejectedValueOnce(new Error("compose failed"))
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["inspect", "cliproxyapi"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(3, "docker", ["pull", "eceasy/cli-proxy-api-plus:latest"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      "docker",
      [
        "compose",
        "--env-file",
        "/opt/cliproxyapi/infrastructure/.env",
        "-f",
        "/opt/cliproxyapi/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ]
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(5, "docker", ["start", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      ["tag", "eceasy/cli-proxy-api-plus:latest", "eceasy/cli-proxy-api-plus:latest"],
    );
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", [
      "compose",
      "--env-file",
      "/opt/cliproxyapi/infrastructure/.env",
      "-f",
      "/opt/cliproxyapi/docker-compose.yml",
      "up",
      "-d",
      "--no-deps",
      "cliproxyapi",
    ]);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(5);
    expect(response.status).toBe(500);
  });

  it("refuses updates when docker compose is unavailable and only attempts a bounded restart", async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error("unknown command: docker compose"))
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["compose", "version"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "docker", ["start", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", ["pull", "eceasy/cli-proxy-api-plus:latest"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", ["rm", "-f", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "-d", "--name", "cliproxyapi"]),
    );
    expect(response.status).toBe(500);
  });

  it("retags the prior immutable latest reference and reruns compose recovery when pull fails before rollout", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:healthy-running","Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockRejectedValueOnce(new Error("pull failed"))
      .mockResolvedValueOnce({ stdout: "retagged", stderr: "" })
      .mockResolvedValueOnce({ stdout: "recovered", stderr: "" });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ version: "latest", confirm: true }),
      })
    );

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "docker", [
      "inspect",
      "cliproxyapi",
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(3, "docker", [
      "pull",
      "eceasy/cli-proxy-api-plus:latest",
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(4, "docker", [
      "tag",
      "sha256:healthy-running",
      "eceasy/cli-proxy-api-plus:latest",
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(5, "docker", [
      "compose",
      "--env-file",
      "/opt/cliproxyapi/infrastructure/.env",
      "-f",
      "/opt/cliproxyapi/docker-compose.yml",
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "cliproxyapi",
    ]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", ["start", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", ["rm", "-f", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "-d", "--name", "cliproxyapi"]),
    );
    expect(response.status).toBe(500);
  });
});
