import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBoundedSseWriter } from "../server/bounded-sse-writer.mjs";

class SlowResponse extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.writeResults = [...writeResults];
    this.writes = [];
    this.destroyed = false;
    this.writableEnded = false;
    this.writableFinished = false;
  }

  write(frame) {
    this.writes.push(frame);
    return this.writeResults.length > 0 ? this.writeResults.shift() : true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

const snapshot = (streamRevision) => ({
  schema: "paris-icc-operations-runtime-v1",
  stateRevision: 1,
  streamRevision,
});

function writtenIds(response) {
  return response.writes
    .filter((frame) => frame.startsWith("id: "))
    .map((frame) => Number(frame.match(/^id: (\d+)/)?.[1]));
}

describe("bounded SSE writer", () => {
  it("keeps only the latest pending snapshot and drops heartbeats under backpressure", () => {
    const response = new SlowResponse([false, true]);
    const writer = createBoundedSseWriter(response, {
      heartbeatMs: 0,
      stalledClientMs: 0,
    });

    expect(writer.offerSnapshot(snapshot(1))).toBe(true);
    expect(writer.blocked).toBe(true);
    writer.offerSnapshot(snapshot(2));
    writer.offerSnapshot(snapshot(3));
    writer.heartbeat();

    expect(writer.pendingRevision).toBe(3);
    expect(writtenIds(response)).toEqual([1]);

    response.emit("drain");
    expect(writer.blocked).toBe(false);
    expect(writer.pendingRevision).toBeNull();
    expect(writtenIds(response)).toEqual([1, 3]);
    expect(response.writes.join("\n")).not.toContain('"streamRevision":2');

    writer.stop();
    expect(response.listenerCount("drain")).toBe(0);
  });

  it("coalesces each pressure window without replaying an accepted frame", () => {
    const response = new SlowResponse([false, false, true]);
    const writer = createBoundedSseWriter(response, {
      heartbeatMs: 0,
      stalledClientMs: 0,
    });

    writer.offerSnapshot(snapshot(1));
    writer.offerSnapshot(snapshot(2));
    writer.offerSnapshot(snapshot(3));
    response.emit("drain");
    writer.offerSnapshot(snapshot(4));
    writer.offerSnapshot(snapshot(5));
    response.emit("drain");

    expect(writtenIds(response)).toEqual([1, 3, 5]);
    expect(writer.blocked).toBe(false);
    writer.stop();
  });

  it("destroys a stalled client and releases timers, queue, and listeners", () => {
    vi.useFakeTimers();
    try {
      const response = new SlowResponse([false]);
      const onTerminate = vi.fn();
      const writer = createBoundedSseWriter(response, {
        heartbeatMs: 1_000,
        stalledClientMs: 5_000,
        onTerminate,
      });

      writer.offerSnapshot(snapshot(1));
      writer.offerSnapshot(snapshot(2));
      expect(writer.pendingRevision).toBe(2);

      vi.advanceTimersByTime(5_000);
      expect(response.destroyed).toBe(true);
      expect(writer.stopped).toBe(true);
      expect(writer.pendingRevision).toBeNull();
      expect(response.listenerCount("drain")).toBe(0);
      expect(onTerminate).toHaveBeenCalledTimes(1);

      response.emit("drain");
      vi.advanceTimersByTime(10_000);
      expect(writtenIds(response)).toEqual([1]);
      expect(onTerminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
