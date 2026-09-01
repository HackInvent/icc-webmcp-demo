import { randomUUID } from "node:crypto";
import { hostname as systemHostname } from "node:os";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const LOCK_SCHEMA = "paris-icc-exclusive-file-lock-v1";
const MAX_LOCK_BYTES = 4_096;

export class ExclusiveFileLockError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "ExclusiveFileLockError";
    this.code = code;
    this.details = details;
  }
}

function lockError(code, message, details = {}, cause) {
  return new ExclusiveFileLockError(
    code,
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM and unknown errors cannot prove that an owner is gone.
    return true;
  }
}

function validOwner(value, targetPath) {
  return value &&
    value.schema === LOCK_SCHEMA &&
    typeof value.token === "string" &&
    /^[a-f0-9-]{16,80}$/i.test(value.token) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.hostname === "string" &&
    value.hostname.length > 0 &&
    value.hostname.length <= 255 &&
    Number.isSafeInteger(value.acquiredAt) &&
    value.acquiredAt >= 0 &&
    value.targetPath === targetPath;
}

async function readOwner(lockPath, targetPath) {
  let source;
  try {
    source = await readFile(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", owner: null };
    return { status: "unverifiable", owner: null, error };
  }
  if (source.length === 0 || source.length > MAX_LOCK_BYTES) {
    return { status: "unverifiable", owner: null };
  }
  try {
    const owner = JSON.parse(source.toString("utf8"));
    return validOwner(owner, targetPath)
      ? { status: "valid", owner }
      : { status: "unverifiable", owner: null };
  } catch (error) {
    return { status: "unverifiable", owner: null, error };
  }
}

async function restoreUnexpectedLock(quarantinePath, lockPath) {
  try {
    await rename(quarantinePath, lockPath);
    return true;
  } catch {
    return false;
  }
}

export async function acquireExclusiveFileLock(options = {}) {
  if (typeof options.targetPath !== "string" || !options.targetPath.trim()) {
    throw lockError("invalid_lock_target", "targetPath is required for an exclusive file lock.");
  }
  const targetPath = path.resolve(options.targetPath);
  const lockPath = path.resolve(options.lockPath ?? `${targetPath}.lock`);
  const localHostname = options.hostname ?? systemHostname();
  const localPid = options.pid ?? process.pid;
  const now = options.now ?? (() => Date.now());
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const tokenFactory = options.tokenFactory ?? randomUUID;
  if (!Number.isSafeInteger(localPid) || localPid <= 0) {
    throw lockError("invalid_lock_owner", "The lock owner PID must be a positive integer.");
  }
  if (typeof localHostname !== "string" || !localHostname || localHostname.length > 255) {
    throw lockError("invalid_lock_owner", "The lock owner hostname is invalid.");
  }
  if (typeof now !== "function" || typeof isProcessAlive !== "function" || typeof tokenFactory !== "function") {
    throw lockError("invalid_lock_options", "Lock clock, liveness check, and token factory must be functions.");
  }
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const owner = {
    schema: LOCK_SCHEMA,
    token: String(tokenFactory()),
    pid: localPid,
    hostname: localHostname,
    acquiredAt: now(),
    targetPath,
  };
  if (!validOwner(owner, targetPath)) {
    throw lockError("invalid_lock_owner", "The generated lock owner metadata is invalid.");
  }

  const create = async () => {
    let handle;
    let created = false;
    try {
      handle = await open(lockPath, "wx", 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (created) await unlink(lockPath).catch(() => {});
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  };

  let staleQuarantinePath = null;
  try {
    await create();
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw lockError("lock_acquisition_failed", `Cannot create lock ${lockPath}.`, { lockPath }, error);
    }
    const observed = await readOwner(lockPath, targetPath);
    if (observed.status === "missing") {
      try {
        await create();
      } catch (retryError) {
        throw lockError("resource_locked", `Another process locked ${targetPath}.`, { lockPath }, retryError);
      }
    } else {
      if (observed.status !== "valid") {
        throw lockError(
          "resource_locked_unverifiable",
          `Lock ${lockPath} cannot be verified and will not be removed automatically.`,
          { lockPath },
          observed.error,
        );
      }
      const previousOwner = observed.owner;
      if (previousOwner.hostname !== localHostname) {
        throw lockError(
          "resource_locked",
          `Another host owns lock ${lockPath}.`,
          { lockPath, owner: previousOwner },
        );
      }
      let alive = true;
      try {
        alive = Boolean(await isProcessAlive(previousOwner.pid));
      } catch {
        alive = true;
      }
      if (alive) {
        throw lockError(
          "resource_locked",
          `Process ${previousOwner.pid} owns lock ${lockPath}.`,
          { lockPath, owner: previousOwner },
        );
      }

      staleQuarantinePath = `${lockPath}.${previousOwner.token}.${owner.token}.stale`;
      try {
        await rename(lockPath, staleQuarantinePath);
      } catch (renameError) {
        throw lockError(
          "resource_locked",
          `Lock ${lockPath} changed while stale ownership was being verified.`,
          { lockPath, owner: previousOwner },
          renameError,
        );
      }
      const quarantined = await readOwner(staleQuarantinePath, targetPath);
      if (quarantined.status !== "valid" || quarantined.owner.token !== previousOwner.token) {
        await restoreUnexpectedLock(staleQuarantinePath, lockPath);
        staleQuarantinePath = null;
        throw lockError(
          "resource_locked_unverifiable",
          `Lock ${lockPath} changed during stale-lock recovery.`,
          { lockPath },
        );
      }
      try {
        await create();
      } catch (createError) {
        throw lockError(
          "resource_locked",
          `Another process acquired ${lockPath} during stale-lock recovery.`,
          { lockPath },
          createError,
        );
      } finally {
        await unlink(staleQuarantinePath).catch(() => {});
        staleQuarantinePath = null;
      }
    }
  }

  let held = true;
  return {
    lockPath,
    owner: { ...owner },
    get held() {
      return held;
    },
    async release() {
      if (!held) return false;
      const releasePath = `${lockPath}.${owner.token}.release`;
      try {
        await rename(lockPath, releasePath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          held = false;
          throw lockError(
            "lock_ownership_lost",
            `Lock ${lockPath} disappeared before release.`,
            { lockPath },
            error,
          );
        }
        throw lockError("lock_release_failed", `Cannot release lock ${lockPath}.`, { lockPath }, error);
      }
      const releasedOwner = await readOwner(releasePath, targetPath);
      if (releasedOwner.status !== "valid" || releasedOwner.owner.token !== owner.token) {
        await restoreUnexpectedLock(releasePath, lockPath);
        throw lockError(
          "lock_ownership_lost",
          `Lock ${lockPath} is no longer owned by this process.`,
          { lockPath },
        );
      }
      await unlink(releasePath);
      held = false;
      return true;
    },
  };
}
