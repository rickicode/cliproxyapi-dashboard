import { mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const LOCK_DIR = path.join(process.cwd(), ".prisma-generate.lock");
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_WAIT_MS = 100;
const LOCK_TIMEOUT_MS = 30 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock() {
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(LOCK_DIR);
      return;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        try {
          const lockStat = await stat(LOCK_DIR);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await rm(LOCK_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for Prisma generate lock at ${LOCK_DIR}`);
        }

        await sleep(LOCK_WAIT_MS);
        continue;
      }

      throw error;
    }
  }
}

async function releaseLock() {
  await rm(LOCK_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function run() {
  await acquireLock();

  try {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["prisma", "generate"],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`prisma generate terminated by signal ${signal}`));
          return;
        }

        resolve(code ?? 1);
      });
    });

    process.exitCode = exitCode;
  } finally {
    await releaseLock();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
