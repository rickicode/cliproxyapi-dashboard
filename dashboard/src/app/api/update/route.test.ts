import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { promisify } from "util";

vi.mock("server-only", () => ({}));

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

describe("POST /api/update", () => {
  beforeEach(() => {
    vi.resetModules();
    verifySessionMock.mockReset();
    validateOriginMock.mockReset();
    findUniqueMock.mockReset();
    execFileAsyncMock.mockReset();
    execFileMock.mockClear();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    findUniqueMock.mockResolvedValue({ isAdmin: true });
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
        "-f",
        "/opt/cliproxyapi/infrastructure/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ],
    );
    expect(execFileAsyncMock).toHaveBeenCalledTimes(4);
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
        "-f",
        "/opt/cliproxyapi/infrastructure/docker-compose.yml",
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
        "-f",
        "/opt/cliproxyapi/infrastructure/docker-compose.yml",
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
        "-f",
        "/opt/cliproxyapi/infrastructure/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ],
    );
    expect(response.status).toBe(500);
  });

  it("falls back without retagging latest for versioned updates when no immutable compose latest reference exists", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "compose-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '{"RepoTags":["eceasy/cli-proxy-api-plus:latest"]}', stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:latest","Env":["A=1"]},"HostConfig":{"Binds":["/tmp:/tmp"],"PortBindings":{},"RestartPolicy":{"Name":"unless-stopped"}},"NetworkSettings":{"Networks":{}}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '{"RepoTags":["eceasy/cli-proxy-api-plus:latest"]}', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "removed", stderr: "" })
      .mockResolvedValueOnce({ stdout: "recreated", stderr: "" });

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
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(4, "docker", ["inspect", "cliproxyapi"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(5, "docker", ["inspect", "cliproxyapi"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(6, "docker", [
      "image",
      "inspect",
      "eceasy/cli-proxy-api-plus:latest",
      "--format",
      "{{json .}}",
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(7, "docker", ["pull", "eceasy/cli-proxy-api-plus:v1.2.3"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(8, "docker", ["rm", "-f", "cliproxyapi"]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      9,
      "docker",
      expect.arrayContaining(["run", "-d", "--name", "cliproxyapi", "eceasy/cli-proxy-api-plus:v1.2.3"]),
    );
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", [
      "tag",
      "eceasy/cli-proxy-api-plus:v1.2.3",
      "eceasy/cli-proxy-api-plus:latest",
    ]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "compose",
        "-f",
        "/opt/cliproxyapi/infrastructure/docker-compose.yml",
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "cliproxyapi",
      ]),
    );
    expect(response.status).toBe(200);
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
        "-f",
        "/opt/cliproxyapi/infrastructure/docker-compose.yml",
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
        "-f",
        "/opt/cliproxyapi/infrastructure/docker-compose.yml",
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
      "-f",
      "/opt/cliproxyapi/infrastructure/docker-compose.yml",
      "up",
      "-d",
      "--no-deps",
      "cliproxyapi",
    ]);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(5);
    expect(response.status).toBe(500);
  });

  it("recreates the original fallback image during bounded docker-run recovery", async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error("unknown command: docker compose"))
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:v1.0.0","Env":["A=1"]},"HostConfig":{"Binds":["/tmp:/tmp"],"PortBindings":{},"RestartPolicy":{"Name":"unless-stopped"}},"NetworkSettings":{"Networks":{}}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:previous-v1","Config":{"Image":"eceasy/cli-proxy-api-plus:v1.0.0"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "removed", stderr: "" })
      .mockRejectedValueOnce(new Error("run failed"))
      .mockResolvedValueOnce({ stdout: "removed-again", stderr: "" })
      .mockResolvedValueOnce({ stdout: "recreated", stderr: "" });

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
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      8,
      "docker",
      expect.arrayContaining(["sha256:previous-v1"]),
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      6,
      "docker",
      expect.arrayContaining(["eceasy/cli-proxy-api-plus:latest"]),
    );
    expect(response.status).toBe(500);
  });

  it("uses the running container image digest for docker-run rollback when config image is mutable latest", async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error("unknown command: docker compose"))
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:running-image","Config":{"Image":"eceasy/cli-proxy-api-plus:latest","Env":["A=1"]},"HostConfig":{"Binds":["/tmp:/tmp"],"PortBindings":{},"RestartPolicy":{"Name":"unless-stopped"}},"NetworkSettings":{"Networks":{}}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:running-image","Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "removed", stderr: "" })
      .mockRejectedValueOnce(new Error("run failed"))
      .mockResolvedValueOnce({ stdout: "removed-again", stderr: "" })
      .mockResolvedValueOnce({ stdout: "recreated", stderr: "" });

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
    expect(execFileAsyncMock.mock.calls).not.toContainEqual([
      "docker",
      ["image", "inspect", "eceasy/cli-proxy-api-plus:latest", "--format", "{{json .}}"],
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      8,
      "docker",
      expect.arrayContaining(["sha256:running-image"]),
    );
    expect(response.status).toBe(500);
  });

  it("does not attempt docker-run rollback when the prior image resolves only to mutable latest", async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error("unknown command: docker compose"))
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:latest","Env":["A=1"]},"HostConfig":{"Binds":["/tmp:/tmp"],"PortBindings":{},"RestartPolicy":{"Name":"unless-stopped"}},"NetworkSettings":{"Networks":{}}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:latest"}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '{"RepoTags":["eceasy/cli-proxy-api-plus:latest"]}', stderr: "" })
      .mockResolvedValueOnce({ stdout: "pull-ok", stderr: "" })
      .mockResolvedValueOnce({ stdout: "removed", stderr: "" })
      .mockRejectedValueOnce(new Error("run failed"))
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
      3,
      "docker",
      ["inspect", "cliproxyapi"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      "docker",
      ["image", "inspect", "eceasy/cli-proxy-api-plus:latest", "--format", "{{json .}}"],
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      7,
      "docker",
      expect.arrayContaining(["eceasy/cli-proxy-api-plus:latest"]),
    );
    expect(execFileAsyncMock).toHaveBeenCalledTimes(7);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(6, "docker", ["rm", "-f", "cliproxyapi"]);
    expect(response.status).toBe(500);
  });

  it("prefers restarting the existing container when docker pull fails before docker-run fallback becomes destructive", async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error("unknown command: docker compose"))
      .mockResolvedValueOnce({ stdout: '[{"Config":{"Image":"eceasy/cli-proxy-api-plus:v1.0.0","Env":["A=1"]},"HostConfig":{"Binds":["/tmp:/tmp"],"PortBindings":{},"RestartPolicy":{"Name":"unless-stopped"}},"NetworkSettings":{"Networks":{}}}]', stderr: "" })
      .mockResolvedValueOnce({ stdout: '[{"Image":"sha256:healthy-running","Config":{"Image":"eceasy/cli-proxy-api-plus:v1.0.0"}}]', stderr: "" })
      .mockRejectedValueOnce(new Error("pull failed"))
      .mockResolvedValueOnce({ stdout: "started", stderr: "" });

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
      "inspect",
      "cliproxyapi",
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(4, "docker", [
      "pull",
      "eceasy/cli-proxy-api-plus:latest",
    ]);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(5, "docker", ["start", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith("docker", ["rm", "-f", "cliproxyapi"]);
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "-d", "--name", "cliproxyapi"]),
    );
    expect(response.status).toBe(500);
  });
});
