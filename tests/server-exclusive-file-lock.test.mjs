import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperationsRepository,
  OperationsRepositoryLockedError,
} from "../server/operations-repository.mjs";
import {
  acquireExclusiveFileLock,
  ExclusiveFileLockError,
} from "../server/exclusive-file-lock.mjs";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function temporaryTarget() {
  const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-lock-"));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    databasePath: path.join(directory, "operations.sqlite"),
  };
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function startRepositoryProcess(databasePath) {
  const repositoryUrl = pathToFileURL(
    path.resolve("server/operations-repository.mjs"),
  ).href;
  const script = `
    import { createOperationsRepository } from ${JSON.stringify(repositoryUrl)};
    const repository = await createOperationsRepository({ databasePath: process.argv[1] });
    process.stdout.write("READY\\n");
    const keepAlive = setInterval(() => {}, 1_000);
    await new Promise((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    clearInterval(keepAlive);
    await repository.close();
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script, databasePath],
    { cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] },
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for child lock process. stderr=${stderr}`));
    }, 8_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("READY\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!stdout.includes("READY\n")) {
        clearTimeout(timeout);
        reject(new Error(`Child exited before locking: code=${code} signal=${signal} stderr=${stderr}`));
      }
    });
  });
  return child;
}

describe("exclusive sql.js database lock", () => {
  it("allows one repository process and releases ownership on graceful close", async () => {
    const { databasePath } = temporaryTarget();
    const child = await startRepositoryProcess(databasePath);
    const lockPath = `${databasePath}.lock`;
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(owner).toMatchObject({ pid: child.pid, targetPath: databasePath });

    await expect(createOperationsRepository({ databasePath }))
      .rejects.toBeInstanceOf(OperationsRepositoryLockedError);

    child.kill("SIGTERM");
    expect(await waitForExit(child)).toEqual({ code: 0, signal: null });
    const repository = await createOperationsRepository({ databasePath });
    await repository.saveRuntime("default", { speed: 0 }, { stateRevision: 1 });
    await repository.close();
    expect(() => statSync(lockPath)).toThrow();
  });

  it("recovers a lock only after its same-host owner is definitely dead", async () => {
    const { directory, databasePath } = temporaryTarget();
    const child = await startRepositoryProcess(databasePath);
    child.kill("SIGKILL");
    expect((await waitForExit(child)).signal).toBe("SIGKILL");

    const repository = await createOperationsRepository({ databasePath });
    expect(JSON.parse(readFileSync(`${databasePath}.lock`, "utf8"))).toMatchObject({
      pid: process.pid,
      targetPath: databasePath,
    });
    expect(readdirSync(directory).filter((name) => name.endsWith(".stale"))).toEqual([]);
    await repository.close();
  });

  it("does not steal malformed ownership that cannot be verified", async () => {
    const { databasePath } = temporaryTarget();
    const lockPath = `${databasePath}.lock`;
    writeFileSync(lockPath, "not-json\n", { mode: 0o600 });

    await expect(acquireExclusiveFileLock({ targetPath: databasePath }))
      .rejects.toMatchObject({
        name: ExclusiveFileLockError.name,
        code: "resource_locked_unverifiable",
      });
    expect(readFileSync(lockPath, "utf8")).toBe("not-json\n");
  });
});
