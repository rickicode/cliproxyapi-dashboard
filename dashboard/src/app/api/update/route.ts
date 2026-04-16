import { NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { execFile } from "child_process";
import { promisify } from "util";
import { Errors, apiSuccess } from "@/lib/errors";
import { UpdateProxySchema } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = "cliproxyapi";
const COMPOSE_FILE = "/opt/cliproxyapi/infrastructure/docker-compose.yml";
const IMAGE_NAME = "eceasy/cli-proxy-api-plus";

interface PortBinding {
  HostIp: string;
  HostPort: string;
}

interface ContainerConfig {
  env: string[];
  volumes: string[];
  networks: string[];
  ports: string[];
  restartPolicy: string;
   configuredImage: string;
}

interface ContainerSnapshot {
  config: ContainerConfig;
   currentImageReference: string | null;
  immutableImageReference: string | null;
}

interface DockerImageInspect {
  Id?: string;
  RepoDigests?: string[];
  RepoTags?: string[];
}

interface DockerContainerInspect {
  Image?: string;
  Config?: {
    Image?: string;
  };
}

function getCommandErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function getContainerConfig(): Promise<ContainerConfig> {
  const { stdout } = await execFileAsync("docker", ["inspect", CONTAINER_NAME]);
   const inspect = JSON.parse(stdout)[0] as DockerContainerInspect & {
     Config: { Env?: string[]; Image?: string };
     HostConfig: {
       Binds?: string[];
       PortBindings?: Record<string, PortBinding[]>;
       RestartPolicy?: { Name?: string };
     };
     NetworkSettings?: { Networks?: Record<string, unknown> };
   };
  const config = inspect.Config;
  const hostConfig = inspect.HostConfig;

  const ports: string[] = [];
  const portBindings: Record<string, PortBinding[]> =
    hostConfig.PortBindings || {};

  for (const containerPort of Object.keys(portBindings)) {
    for (const binding of portBindings[containerPort] || []) {
      const hostIp = binding.HostIp || "";
      const hostPort = binding.HostPort;
      const port = containerPort.replace("/tcp", "");
      ports.push(hostIp ? `${hostIp}:${hostPort}:${port}` : `${hostPort}:${port}`);
    }
  }

  return {
    env: config.Env || [],
    volumes: hostConfig.Binds || [],
    networks: Object.keys(inspect.NetworkSettings?.Networks || {}),
    ports,
    restartPolicy: hostConfig.RestartPolicy?.Name || "unless-stopped",
    configuredImage: config.Image || IMAGE_NAME,
  };
}

function isImmutableImageReference(imageReference: string | null | undefined): boolean {
  if (!imageReference) {
    return false;
  }

  return imageReference.startsWith("sha256:") || imageReference.includes("@");
}

async function getImageReference(imageTag: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "image",
      "inspect",
      imageTag,
      "--format",
      "{{json .}}",
    ]);

    const inspect = JSON.parse(stdout) as DockerImageInspect;
    return inspect.Id || inspect.RepoDigests?.[0] || inspect.RepoTags?.[0] || null;
  } catch (error) {
    const errorText = getCommandErrorText(error);
    if (errorText.includes("No such object") || errorText.includes("No such image")) {
      return null;
    }

    throw error;
  }
}

async function getContainerImageReference(containerName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", containerName]);
    const inspect = JSON.parse(stdout)[0] as DockerContainerInspect | undefined;

    return inspect?.Image || inspect?.Config?.Image || null;
  } catch (error) {
    const errorText = getCommandErrorText(error);
    if (errorText.includes("No such container")) {
      return null;
    }

    throw error;
  }
}

async function getContainerSnapshot(): Promise<ContainerSnapshot> {
  const config = await getContainerConfig();
  const currentImageReference = await getContainerImageReference(CONTAINER_NAME);
  const immutableImageReference = isImmutableImageReference(currentImageReference)
    ? currentImageReference
    : isImmutableImageReference(config.configuredImage)
      ? config.configuredImage
      : await getImageReference(config.configuredImage);

  return {
    config,
    currentImageReference,
    immutableImageReference: isImmutableImageReference(immutableImageReference)
      ? immutableImageReference
      : null,
  };
}

function buildRunArgs(cfg: ContainerConfig, imageTag: string): string[] {
  const args = [
    "run", "-d", "--name", CONTAINER_NAME,
    "--restart", cfg.restartPolicy || "unless-stopped",
  ];

  for (const env of cfg.env) { args.push("-e", env); }
  for (const vol of cfg.volumes) { args.push("-v", vol); }
  for (const port of cfg.ports) { args.push("-p", port); }
  for (const net of cfg.networks) { args.push("--network", net); }

  args.push(
    "--health-cmd", "wget --no-verbose --tries=1 -O /dev/null http://localhost:8317/",
    "--health-interval", "30s",
    "--health-timeout", "10s",
    "--health-retries", "3",
    "--health-start-period", "20s"
  );

  args.push(imageTag);
  return args;
}

async function removeContainerIfExists() {
  try {
    await execFileAsync("docker", ["rm", "-f", CONTAINER_NAME]);
  } catch (error) {
    const errorText = getCommandErrorText(error);
    if (!errorText.includes("No such container")) {
      throw error;
    }
  }
}

async function recreateWithDockerRun(config: ContainerConfig, imageTag: string) {
  await removeContainerIfExists();
  await execFileAsync("docker", buildRunArgs(config, imageTag));
}

async function startContainerIfExists() {
  try {
    await execFileAsync("docker", ["start", CONTAINER_NAME]);
    return true;
  } catch (error) {
    const errorText = getCommandErrorText(error);
    if (
      errorText.includes("No such container") ||
      errorText.includes(`No such container: ${CONTAINER_NAME}`)
    ) {
      return false;
    }

    throw error;
  }
}

async function runCompose(args: string[]) {
  return execFileAsync("docker", ["compose", "-f", COMPOSE_FILE, ...args]);
}

async function isComposeAvailable() {
  try {
    await execFileAsync("docker", ["compose", "version"]);
    return true;
  } catch (error) {
    const errorText = getCommandErrorText(error);
    const composeMissing =
      errorText.includes("unknown command: docker compose") ||
      errorText.includes("unknown shorthand flag: 'f' in -f");

    if (composeMissing) {
      logger.info("Docker compose not available in runtime, using docker run fallback");
    } else {
      logger.warn({ err: error }, "Compose availability check failed, using fallback");
    }

    return false;
  }
}

export async function POST(request: NextRequest) {
  const session = await verifySession();

  if (!session) {
    return Errors.unauthorized();
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { isAdmin: true },
  });

  if (!user?.isAdmin) {
    return Errors.forbidden();
  }

  const originError = validateOrigin(request);
  if (originError) return originError;

  let containerSnapshot: ContainerSnapshot | null = null;
  let composeAvailable = false;
  let useComposeRollout = false;
  let recoveryImageReference: string | null = null;
  let previousComposeLatestRef: string | null = null;
  let retaggedComposeLatest = false;
  let shouldRestoreComposeLatest = false;
  let version: string | null = null;
  let nonComposeFallbackBecameDestructive = false;

  try {
    const body = await request.json();
    const result = UpdateProxySchema.safeParse(body);

    if (!result.success) {
      return Errors.zodValidation(result.error.issues);
    }

    version = result.data.version;

    const imageTag = `${IMAGE_NAME}:${version}`;
    composeAvailable = await isComposeAvailable();

    if (composeAvailable) {
      previousComposeLatestRef = await getContainerImageReference(CONTAINER_NAME);

      if (!isImmutableImageReference(previousComposeLatestRef)) {
        previousComposeLatestRef = null;
      }

      if (!previousComposeLatestRef && version !== "latest") {
        const composeLatestImageReference = await getImageReference(`${IMAGE_NAME}:latest`);
        previousComposeLatestRef = isImmutableImageReference(composeLatestImageReference)
          ? composeLatestImageReference
          : null;
      }

      shouldRestoreComposeLatest = Boolean(previousComposeLatestRef);
      useComposeRollout = version === "latest" || shouldRestoreComposeLatest;

      if (!useComposeRollout) {
        containerSnapshot = await getContainerSnapshot();
        recoveryImageReference = containerSnapshot.immutableImageReference;
      }
    } else {
      containerSnapshot = await getContainerSnapshot();
      recoveryImageReference = containerSnapshot.immutableImageReference;
    }

    const pullResult = await execFileAsync("docker", ["pull", imageTag]);
    logger.info({ stdout: pullResult.stdout }, "Pull result");

    if (useComposeRollout && version !== "latest") {
      await execFileAsync("docker", ["tag", imageTag, `${IMAGE_NAME}:latest`]);
      retaggedComposeLatest = true;
      logger.info({ version }, "Tagged selected version as latest for compose rollout");
    }

    if (useComposeRollout) {
      await runCompose(["up", "-d", "--no-deps", "--force-recreate", CONTAINER_NAME]);
    } else {
      if (!containerSnapshot) {
        throw new Error("Missing container configuration for docker run fallback");
      }

       nonComposeFallbackBecameDestructive = true;
      await recreateWithDockerRun(containerSnapshot.config, imageTag);
    }

    return apiSuccess({ message: `Updated to ${version}`, version });
  } catch (error) {
    try {
      if (composeAvailable && useComposeRollout) {
        try {
          if (shouldRestoreComposeLatest && (version === "latest" || retaggedComposeLatest)) {
            if (previousComposeLatestRef) {
              await execFileAsync("docker", [
                "tag",
                previousComposeLatestRef,
                `${IMAGE_NAME}:latest`,
              ]);
              logger.info(
                { previousComposeLatestRef },
                "Recovery: restored previous compose latest image reference"
              );
            } else {
              logger.warn(
                "Recovery: no previous latest image reference available; skipping compose recreation"
              );
              throw new Error("No previous latest image reference available for bounded compose recovery");
            }
          }

          if (shouldRestoreComposeLatest || (version !== "latest" && !retaggedComposeLatest)) {
            await runCompose(["up", "-d", "--no-deps", "--force-recreate", CONTAINER_NAME]);
            logger.info("Recovery: compose ensured proxy service is up");
          } else {
            throw new Error("No immutable previous latest image reference available for bounded compose recovery");
          }
        } catch (composeRecoveryError) {
          logger.warn(
            { err: composeRecoveryError },
            "Compose recovery failed, trying to restart existing proxy container"
          );

          const started = await startContainerIfExists();
          if (started) {
            logger.info("Recovery: restarted existing proxy container");
          }
        }
      } else if ((!composeAvailable || !useComposeRollout) && !nonComposeFallbackBecameDestructive) {
        const started = await startContainerIfExists();
        if (started) {
          logger.info("Recovery: ensured existing proxy container is still running");
        } else {
          logger.warn(
            "Recovery: existing proxy container was untouched but could not be restarted because it no longer exists"
          );
        }
      } else if (containerSnapshot && recoveryImageReference) {
        await recreateWithDockerRun(containerSnapshot.config, recoveryImageReference);
        logger.info(
          { recoveryImageReference },
          "Recovery: recreated proxy container with previous immutable image"
        );
      } else if (!composeAvailable || !useComposeRollout) {
        logger.warn(
          "Recovery: no immutable previous image reference available; skipping docker run recreation"
        );
      }
    } catch (restartError) {
      logger.error({ err: restartError }, "Recovery failed");
    }

    return Errors.internal("Update failed", error);
  }
}
