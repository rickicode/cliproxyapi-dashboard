import { NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { execFile } from "child_process";
import { promisify } from "util";
import { access, readFile } from "fs/promises";
import { ERROR_CODE, Errors, apiError, apiSuccess } from "@/lib/errors";
import { UpdateProxySchema } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = "cliproxyapi";
const COMPOSE_FILE = "/opt/cliproxyapi/docker-compose.yml";
const COMPOSE_ENV_FILE = "/opt/cliproxyapi/infrastructure/.env";
const IMAGE_NAME = "eceasy/cli-proxy-api-plus";
const ENV_FILE_REQUIRED_VARS = ["DATABASE_URL", "MANAGEMENT_API_KEY", "JWT_SECRET"] as const;

class ComposeCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeCompatibilityError";
  }
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
  return execFileAsync("docker", [
    "compose",
    "--env-file",
    COMPOSE_ENV_FILE,
    "-f",
    COMPOSE_FILE,
    ...args,
  ]);
}

async function readComposeEnvFile() {
  return readFile(COMPOSE_ENV_FILE, "utf8");
}

async function validateComposeRuntimeFiles() {
  try {
    await access(COMPOSE_FILE);
  } catch {
    throw new ComposeCompatibilityError(
      `Update compose rollout requires mounted compose file at ${COMPOSE_FILE}`
    );
  }

  try {
    await access(COMPOSE_ENV_FILE);
  } catch {
    throw new ComposeCompatibilityError(
      `Update compose rollout requires mounted compose env file at ${COMPOSE_ENV_FILE}`
    );
  }
}

function parseEnvFile(envContent: string) {
  const values = new Map<string, string>();

  for (const rawLine of envContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = normalizeEnvValue(line.slice(separatorIndex + 1).trim());
    values.set(key, value);
  }

  return values;
}

function normalizeEnvValue(value: string) {
  if (value.length >= 2) {
    const firstChar = value[0];
    const lastChar = value[value.length - 1];
    if ((firstChar === '"' || firstChar === "'") && firstChar === lastChar) {
      return value.slice(1, -1);
    }
  }

  return value;
}

async function validateComposeEnvForProxyRollout() {
  await validateComposeRuntimeFiles();
  const envFileContents = await readComposeEnvFile();
  const envValues = parseEnvFile(envFileContents);
  const dbMode = envValues.get("DB_MODE") || "docker";

  if (dbMode !== "docker" && dbMode !== "external") {
    throw new Error(`Unsupported DB_MODE '${dbMode}' in compose env file`);
  }

  for (const key of ENV_FILE_REQUIRED_VARS) {
    if (!envValues.get(key)) {
      throw new Error(`Compose env file is missing required ${key}`);
    }
  }

  if (dbMode === "docker" && !envValues.get("POSTGRES_PASSWORD")) {
    throw new Error("Compose env file is missing required POSTGRES_PASSWORD for DB_MODE=docker");
  }

  return { dbMode };
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
      logger.info("Docker compose not available in runtime; update fallback is disabled");
    } else {
      logger.warn({ err: error }, "Compose availability check failed; update fallback is disabled");
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

  let composeAvailable = false;
  let useComposeRollout = false;
  let previousComposeLatestRef: string | null = null;
  let retaggedComposeLatest = false;
  let shouldRestoreComposeLatest = false;
  let version: string | null = null;

  try {
    const body = await request.json();
    const result = UpdateProxySchema.safeParse(body);

    if (!result.success) {
      return Errors.zodValidation(result.error.issues);
    }

    version = result.data.version;

    const imageTag = `${IMAGE_NAME}:${version}`;
    composeAvailable = await isComposeAvailable();

    if (!composeAvailable) {
      throw new Error(
        "Docker compose is not available in the runtime; refusing unsafe docker run update fallback"
      );
    }

    await validateComposeEnvForProxyRollout();

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
      throw new Error(
        `Cannot safely roll out ${version} without an immutable previous latest image reference`
      );
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
      } else if (!composeAvailable || !useComposeRollout) {
        const started = await startContainerIfExists();
        if (started) {
          logger.info("Recovery: ensured existing proxy container is still running");
        } else {
          logger.warn(
            "Recovery: existing proxy container was untouched but could not be restarted because it no longer exists"
          );
        }
      }
    } catch (restartError) {
      logger.error({ err: restartError }, "Recovery failed");
    }

    if (error instanceof ComposeCompatibilityError) {
      return apiError(ERROR_CODE.CONFIG_ERROR, error.message, 500);
    }

    return Errors.internal("Update failed", error);
  }
}
