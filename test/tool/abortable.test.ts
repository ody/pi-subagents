import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, waitForRunEnd } from "../../src/tool/abortable.js";

async function withUnhandledRejectionSpy(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const prior = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const capture = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", capture);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", capture);
    for (const l of prior) process.on("unhandledRejection", l as never);
  }
  return seen;
}

describe("abortable", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the original promise untouched when there is no signal", async () => {
    const promise = Promise.resolve("value");
    expect(abortable(promise)).toBe(promise);
    await expect(promise).resolves.toBe("value");
  });

  it("rejects immediately with the signal's reason when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone before we started"));
    await expect(abortable(new Promise(() => {}), controller.signal))
      .rejects.toThrow("gone before we started");
  });

  it("resolves normally when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve(42), controller.signal)).resolves.toBe(42);
  });

  it("propagates a rejection from the wrapped promise", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.reject(new Error("work failed")), controller.signal))
      .rejects.toThrow("work failed");
  });

  it("rejects with the abort reason when the signal fires mid-wait", async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise(() => {}), controller.signal);
    controller.abort(new Error("user pressed Esc"));
    await expect(pending).rejects.toThrow("user pressed Esc");
  });

  it("absorbs a late REJECTION of the wrapped promise after an abort", async () => {
    const unhandled = await withUnhandledRejectionSpy(async () => {
      const controller = new AbortController();
      let failChild: ((e: unknown) => void) | undefined;
      const childWork = new Promise((_resolve, reject) => { failChild = reject; });

      const pending = abortable(childWork, controller.signal);
      controller.abort(new Error("stopped waiting"));
      await expect(pending).rejects.toThrow("stopped waiting");

      failChild!(new Error("child died later"));
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(unhandled).toEqual([]);
  });

  it("absorbs a late RESOLUTION of the wrapped promise after an abort", async () => {
    const controller = new AbortController();
    let finishChild: ((v: string) => void) | undefined;
    const childWork = new Promise<string>((resolve) => { finishChild = resolve; });

    const pending = abortable(childWork, controller.signal);
    controller.abort(new Error("stopped waiting"));
    await expect(pending).rejects.toThrow("stopped waiting");

    finishChild!("child finished anyway");
    await expect(childWork).resolves.toBe("child finished anyway");
  });

  it("removes its abort listener once the promise resolves", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await abortable(Promise.resolve("done"), controller.signal);

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes its abort listener once the promise rejects", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await expect(abortable(Promise.reject(new Error("nope")), controller.signal)).rejects.toThrow();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("a late abort after normal settlement is inert", async () => {
    const unhandled = await withUnhandledRejectionSpy(async () => {
      const controller = new AbortController();
      await expect(abortable(Promise.resolve("done"), controller.signal)).resolves.toBe("done");
      controller.abort(new Error("much later"));
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(unhandled).toEqual([]);
  });

  it("does not leak a listener per wait on a shared parent signal", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    for (let i = 0; i < 20; i++) {
      await abortable(Promise.resolve(i), controller.signal);
    }

    expect(remove).toHaveBeenCalledTimes(20);
  });
});

describe("waitForRunEnd", () => {
  it("returns at once for a finished run, even when its promise never settles", async () => {
    const record = { status: "completed" as const, promise: new Promise<string>(() => {}) };
    await expect(waitForRunEnd(record, undefined, 5)).resolves.toBeUndefined();
  });

  it("waits for a running run's promise", async () => {
    let finish!: (text: string) => void;
    const record = { status: "running" as const, promise: new Promise<string>(resolve => { finish = resolve; }) };
    let done = false;
    const waiting = waitForRunEnd(record, undefined, 5).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    finish("ok");
    await waiting;
    expect(done).toBe(true);
  });

  it("polls while queued, then waits for the promise", async () => {
    const record: { status: "queued" | "running"; promise?: Promise<string> } = { status: "queued" };
    const waiting = waitForRunEnd(record, undefined, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    record.status = "running";
    record.promise = Promise.resolve("ok");
    await expect(waiting).resolves.toBeUndefined();
  });

  it("rejects when the signal aborts", async () => {
    const controller = new AbortController();
    const record = { status: "running" as const, promise: new Promise<string>(() => {}) };
    const waiting = waitForRunEnd(record, controller.signal, 5);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
  });
});
