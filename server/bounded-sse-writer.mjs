export function snapshotStreamRevision(snapshot) {
  return snapshot?.streamRevision ?? snapshot?.stateRevision;
}

function snapshotFrame(snapshot) {
  return (
    `id: ${snapshotStreamRevision(snapshot)}\n` +
    "event: snapshot\n" +
    `data: ${JSON.stringify(snapshot)}\n\n`
  );
}

export function createBoundedSseWriter(response, options = {}) {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const stalledClientMs = options.stalledClientMs ?? 45_000;
  const onTerminate = options.onTerminate ?? (() => {});
  let stopped = false;
  let blocked = false;
  let pendingSnapshot = null;
  let lastWrittenRevision = -1;
  let heartbeatTimer = null;
  let stallTimer = null;

  const writable = () =>
    !stopped &&
    !response.destroyed &&
    !response.writableEnded &&
    !response.writableFinished;

  const clearStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    blocked = false;
    pendingSnapshot = null;
    clearStallTimer();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    response.off?.("drain", handleDrain);
    onTerminate();
  };

  const enterBackpressure = () => {
    blocked = true;
    if (!stallTimer && stalledClientMs > 0) {
      stallTimer = setTimeout(() => {
        try {
          response.destroy?.();
        } finally {
          stop();
        }
      }, stalledClientMs);
      stallTimer.unref?.();
    }
  };

  const writeFrame = (frame) => {
    if (!writable()) {
      stop();
      return false;
    }
    try {
      if (!response.write(frame)) enterBackpressure();
      return true;
    } catch {
      try {
        response.destroy?.();
      } finally {
        stop();
      }
      return false;
    }
  };

  const offerSnapshot = (snapshot) => {
    if (!writable()) {
      stop();
      return false;
    }
    const revision = snapshotStreamRevision(snapshot);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision <= lastWrittenRevision) {
      return false;
    }
    if (blocked) {
      if (
        pendingSnapshot === null ||
        revision > snapshotStreamRevision(pendingSnapshot)
      ) {
        // One reference only: all superseded intermediate snapshots are dropped.
        pendingSnapshot = snapshot;
      }
      return true;
    }
    if (!writeFrame(snapshotFrame(snapshot))) return false;
    lastWrittenRevision = revision;
    return true;
  };

  function handleDrain() {
    if (!writable()) {
      stop();
      return;
    }
    blocked = false;
    clearStallTimer();
    const latest = pendingSnapshot;
    pendingSnapshot = null;
    if (latest) offerSnapshot(latest);
  }

  const heartbeat = () => {
    if (!writable()) {
      stop();
      return;
    }
    // Heartbeats are disposable and are never queued behind a snapshot.
    if (!blocked) writeFrame(": heartbeat\n\n");
  };

  response.on?.("drain", handleDrain);
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(heartbeat, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  return {
    offerSnapshot,
    heartbeat,
    stop,
    get blocked() {
      return blocked;
    },
    get pendingRevision() {
      return pendingSnapshot === null ? null : snapshotStreamRevision(pendingSnapshot);
    },
    get stopped() {
      return stopped;
    },
  };
}
