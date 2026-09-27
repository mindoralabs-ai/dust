import { Worker } from "@temporalio/worker";
import { describe, expect, it, vi } from "vitest";

import {
  areTemporalWorkersRunning,
  createTemporalWorker,
  runInWorkerContext,
} from "./bundle_helper";

vi.mock("@temporalio/worker", () => ({
  Worker: { create: vi.fn() },
}));

describe("selected Temporal worker readiness", () => {
  it("waits for every selected worker and rejects stopped workers", async () => {
    const first = { getState: vi.fn(() => "INITIALIZED") };
    const second = { getState: vi.fn(() => "RUNNING") };
    vi.mocked(Worker.create)
      .mockResolvedValueOnce(first as unknown as Worker)
      .mockResolvedValueOnce(second as unknown as Worker);

    const selected = ["sandbox_functions", "sandbox_reaper"] as const;
    expect(areTemporalWorkersRunning([...selected])).toBe(false);

    await runInWorkerContext(selected[0], () =>
      createTemporalWorker({} as Parameters<typeof Worker.create>[0])
    );
    expect(areTemporalWorkersRunning([...selected])).toBe(false);

    first.getState.mockReturnValue("RUNNING");
    expect(areTemporalWorkersRunning([...selected])).toBe(false);

    await runInWorkerContext(selected[1], () =>
      createTemporalWorker({} as Parameters<typeof Worker.create>[0])
    );
    expect(areTemporalWorkersRunning([...selected])).toBe(true);

    second.getState.mockReturnValue("STOPPING");
    expect(areTemporalWorkersRunning([...selected])).toBe(false);
  });
});
