import { Worker } from "@temporalio/worker";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import {
  areTemporalWorkersRunning,
  createTemporalWorker,
  runInWorkerContext,
} from "./bundle_helper";

vi.mock("@temporalio/worker", () => ({
  Worker: { create: vi.fn() },
}));

type WorkerState = ReturnType<Worker["getState"]>;

function makeWorker(state: WorkerState) {
  return { getState: vi.fn((): WorkerState => state) };
}

const workerOptions = {} as Parameters<typeof Worker.create>[0];

// The tracked workers live in module state, so each test selects different worker names.
describe("selected Temporal worker readiness", () => {
  it("never reports an empty selection as ready", () => {
    expect(areTemporalWorkersRunning([])).toBe(false);
  });

  it("waits for every selected worker and rejects stopped workers", async () => {
    const first = makeWorker("INITIALIZED");
    const second = makeWorker("RUNNING");
    vi.mocked(Worker.create)
      .mockResolvedValueOnce(first as unknown as Worker)
      .mockResolvedValueOnce(second as unknown as Worker);

    const selected = ["bigquery", "confluence"] as const;
    expect(areTemporalWorkersRunning([...selected])).toBe(false);

    await runInWorkerContext(selected[0], () =>
      createTemporalWorker(workerOptions)
    );
    expect(areTemporalWorkersRunning([...selected])).toBe(false);

    first.getState.mockReturnValue("RUNNING");
    expect(areTemporalWorkersRunning([...selected])).toBe(false);

    await runInWorkerContext(selected[1], () =>
      createTemporalWorker(workerOptions)
    );
    expect(areTemporalWorkersRunning([...selected])).toBe(true);

    second.getState.mockReturnValue("STOPPING");
    expect(areTemporalWorkersRunning([...selected])).toBe(false);
  });

  it("requires every Temporal worker created for one worker name to run", async () => {
    const running = makeWorker("RUNNING");
    const failed = makeWorker("FAILED");
    vi.mocked(Worker.create)
      .mockResolvedValueOnce(running as unknown as Worker)
      .mockResolvedValueOnce(failed as unknown as Worker);

    await runInWorkerContext("webcrawler", async () => {
      await createTemporalWorker(workerOptions);
      await createTemporalWorker(workerOptions);
    });

    expect(areTemporalWorkersRunning(["webcrawler"])).toBe(false);
    failed.getState.mockReturnValue("RUNNING");
    expect(areTemporalWorkersRunning(["webcrawler"])).toBe(true);
  });

  it("tracks each worker under the context it was created in, across awaits", async () => {
    const gong = makeWorker("RUNNING");
    const intercom = makeWorker("DRAINING");
    vi.mocked(Worker.create)
      .mockResolvedValueOnce(intercom as unknown as Worker)
      .mockResolvedValueOnce(gong as unknown as Worker);

    // The gong worker awaits before creating its Temporal worker, as runDustProjectWorker awaits
    // its connection, so the intercom worker is created first.
    await Promise.all([
      runInWorkerContext("gong", async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return createTemporalWorker(workerOptions);
      }),
      runInWorkerContext("intercom", () => createTemporalWorker(workerOptions)),
    ]);

    expect(areTemporalWorkersRunning(["gong"])).toBe(true);
    expect(areTemporalWorkersRunning(["intercom"])).toBe(false);
    expect(areTemporalWorkersRunning(["gong", "intercom"])).toBe(false);
  });

  it("does not track a worker created outside a worker context", async () => {
    const notion = makeWorker("RUNNING");
    const untracked = makeWorker("FAILED");
    vi.mocked(Worker.create)
      .mockResolvedValueOnce(notion as unknown as Worker)
      .mockResolvedValueOnce(untracked as unknown as Worker);

    await runInWorkerContext("notion", () =>
      createTemporalWorker(workerOptions)
    );
    await expect(createTemporalWorker(workerOptions)).resolves.toBe(untracked);

    expect(areTemporalWorkersRunning(["notion"])).toBe(true);
    expect(untracked.getState).not.toHaveBeenCalled();
  });

  it("propagates a Worker.create failure without tracking a worker", async () => {
    const error = new Error("connection refused");
    vi.mocked(Worker.create).mockRejectedValueOnce(error);

    await expect(
      runInWorkerContext("salesforce", () =>
        createTemporalWorker(workerOptions)
      )
    ).rejects.toBe(error);

    expect(areTemporalWorkersRunning(["salesforce"])).toBe(false);
  });
});

describe("connector worker sources", () => {
  // Readiness only sees Workers made by createTemporalWorker, so a connector that calls
  // Worker.create directly could never report ready once selected.
  const connectorsDir = path.join(__dirname, "..", "connectors");
  const workerSources = readdirSync(connectorsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.join(connectorsDir, entry.name, "temporal", "worker.ts")
    )
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    });

  it("finds the connector workers", () => {
    expect(workerSources.length).toBeGreaterThan(10);
  });

  it.each(
    workerSources.map((file) => [path.relative(connectorsDir, file), file])
  )("%s creates its Temporal Workers with createTemporalWorker", (_name, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/\bWorker\.create\(/);
    expect(source).toMatch(/\bcreateTemporalWorker\(/);
  });
});
