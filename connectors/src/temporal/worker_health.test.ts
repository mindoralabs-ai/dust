import { request } from "node:http";
import { createServer, Server } from "node:net";
import logger from "@connectors/logger/logger";
import type { Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTemporalWorker, runInWorkerContext } from "./bundle_helper";
import {
  parseWorkerHealthPort,
  startWorkerHealthServer,
  superviseWorkers,
  workerSelectionArgs,
} from "./worker_health";
import type { WorkerName } from "./worker_registry";

type TemporalWorkerState = ReturnType<Worker["getState"]>;
type FakeTemporalWorker = {
  state: TemporalWorkerState;
  getState: () => TemporalWorkerState;
};

const { pendingTemporalWorkers } = vi.hoisted(() => ({
  pendingTemporalWorkers: new Array<FakeTemporalWorker>(),
}));

// Only Worker.create is replaced: readiness is computed by the real bundle_helper tracking.
vi.mock("@temporalio/worker", () => ({
  Worker: { create: async () => pendingTemporalWorkers.shift() },
}));

// Creates a tracked Temporal worker through the real `createTemporalWorker`, under the worker
// context of the caller.
async function createFakeTemporalWorker(
  state: TemporalWorkerState
): Promise<FakeTemporalWorker> {
  const worker: FakeTemporalWorker = { state, getState: () => worker.state };
  pendingTemporalWorkers.push(worker);
  await createTemporalWorker({ taskQueue: "worker-health-test" });
  return worker;
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map(
        (server) =>
          new Promise((resolve) =>
            server.listening ? server.close(resolve) : resolve(undefined)
          )
      )
  );
  vi.restoreAllMocks();
});

function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port.");
  }
  return address.port;
}

async function listenOnLoopback(): Promise<Server> {
  const server = createServer();
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function freePort(): Promise<number> {
  const server = await listenOnLoopback();
  const port = listeningPort(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startHealthServer(
  workers: WorkerName[],
  isShuttingDown: () => boolean
) {
  const server = await startWorkerHealthServer(0, workers, isShuttingDown);
  openServers.push(server);
  return listeningPort(server);
}

function httpStatus(
  port: number,
  { method = "GET", path = "/readyz" } = {}
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    request(
      { host: "127.0.0.1", port, method, path, agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    )
      .once("error", reject)
      .end();
  });
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function supervision({
  runWorker = async () => {},
  healthPort,
}: {
  runWorker?: (worker: WorkerName) => Promise<void>;
  healthPort?: string;
} = {}) {
  const listeners = new Map<string, () => void>();
  return {
    runWorker: vi.fn(runWorker),
    healthPort,
    onceSignal: vi.fn((signal: string, listener: () => void) => {
      listeners.set(signal, listener);
    }),
    exit: vi.fn(),
    send: (signal: "SIGTERM" | "SIGINT") => listeners.get(signal)?.(),
  };
}

async function parseWorkerArgs(argv: string[]) {
  // `fail(false)` makes yargs reject instead of printing usage and exiting the test process.
  return workerSelectionArgs(argv, ["dust_project", "slack", "notion"])
    .fail(false)
    .parseAsync();
}

describe("worker selection arguments", () => {
  it("parses a bare --workers flag to an empty selection instead of every worker", async () => {
    for (const argv of [["--workers"], ["--workers="], ["-w"]]) {
      await expect(parseWorkerArgs(argv)).resolves.toMatchObject({
        workers: [],
      });
    }
  });

  it("leaves the selection unset when --workers is omitted", async () => {
    const args = await parseWorkerArgs([]);
    expect(args.workers).toBeUndefined();
  });

  it("keeps every given worker, including duplicates", async () => {
    await expect(
      parseWorkerArgs(["--workers", "slack", "notion", "slack"])
    ).resolves.toMatchObject({ workers: ["slack", "notion", "slack"] });
  });

  it("rejects an unknown worker", async () => {
    await expect(
      parseWorkerArgs(["--workers", "dust_project", "unknown_worker"])
    ).rejects.toThrow(/Invalid values/);
  });
});

describe("WORKER_HEALTH_PORT parsing", () => {
  it("returns no port when the value is unset or empty", () => {
    expect(parseWorkerHealthPort(undefined)).toBeUndefined();
    expect(parseWorkerHealthPort("")).toBeUndefined();
  });

  it("accepts a TCP port", () => {
    expect(parseWorkerHealthPort("1")).toBe(1);
    expect(parseWorkerHealthPort("8081")).toBe(8081);
    expect(parseWorkerHealthPort("65535")).toBe(65535);
  });

  it("rejects a value that is not a TCP port", () => {
    for (const value of ["0", "65536", "-1", "80.5", "port", " "]) {
      expect(() => parseWorkerHealthPort(value)).toThrow(
        "WORKER_HEALTH_PORT must be a valid TCP port."
      );
    }
  });
});

// The tracked Temporal workers live in bundle_helper module state, so each test selects different
// worker names.
describe("worker health listener", () => {
  it("binds to 127.0.0.1 only", async () => {
    const server = await startWorkerHealthServer(0, ["bigquery"], () => false);
    openServers.push(server);

    expect(server.address()).toMatchObject({
      address: "127.0.0.1",
      family: "IPv4",
    });
  });

  it("returns 200 only while not shutting down and every selected worker runs", async () => {
    let shuttingDown = false;
    const port = await startHealthServer(
      ["confluence", "github"],
      () => shuttingDown
    );
    expect(await httpStatus(port)).toBe(503);

    const confluence = await runInWorkerContext("confluence", () =>
      createFakeTemporalWorker("RUNNING")
    );
    expect(await httpStatus(port)).toBe(503);

    const github = await runInWorkerContext("github", () =>
      createFakeTemporalWorker("INITIALIZED")
    );
    expect(await httpStatus(port)).toBe(503);

    github.state = "RUNNING";
    expect(await httpStatus(port)).toBe(200);

    shuttingDown = true;
    expect(await httpStatus(port)).toBe(503);

    shuttingDown = false;
    confluence.state = "STOPPING";
    expect(await httpStatus(port)).toBe(503);
  });

  it("returns 404 for any other method or path", async () => {
    const port = await startHealthServer(["gong"], () => false);
    await runInWorkerContext("gong", () => createFakeTemporalWorker("RUNNING"));
    expect(await httpStatus(port)).toBe(200);

    for (const probe of [
      { method: "POST" },
      { method: "HEAD" },
      { path: "/" },
      { path: "/healthz" },
      { path: "/readyz/" },
      { path: "/readyz?probe=1" },
    ]) {
      expect(await httpStatus(port, probe)).toBe(404);
    }
  });

  it("rejects when the port cannot be listened on", async () => {
    const port = listeningPort(await listenOnLoopback());

    await expect(
      startWorkerHealthServer(port, ["intercom"], () => false)
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("worker supervision", () => {
  it("rejects an empty or duplicated selection before anything starts", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const selections: WorkerName[][] = [[], ["microsoft", "microsoft"]];
    for (const workers of selections) {
      const options = supervision({ healthPort: String(await freePort()) });
      listen.mockClear();

      await expect(superviseWorkers(workers, options)).rejects.toThrow(
        "Select at least one Temporal worker without duplicates."
      );
      expect(options.onceSignal).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      expect(options.runWorker).not.toHaveBeenCalled();
      expect(options.exit).not.toHaveBeenCalled();
    }
  });

  it("rejects an invalid health port before any worker starts", async () => {
    const options = supervision({ healthPort: "70000" });

    await expect(superviseWorkers(["notion"], options)).rejects.toThrow(
      "WORKER_HEALTH_PORT must be a valid TCP port."
    );
    expect(options.runWorker).not.toHaveBeenCalled();
  });

  it("rejects a health listener error before any worker starts", async () => {
    const port = listeningPort(await listenOnLoopback());
    const options = supervision({ healthPort: String(port) });

    await expect(
      superviseWorkers(["notion_garbage_collector"], options)
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(options.runWorker).not.toHaveBeenCalled();
  });

  it("opens no health listener when the health port is unset or empty", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    for (const healthPort of [undefined, ""]) {
      const options = supervision({ healthPort });
      options.runWorker.mockImplementation(async () => options.send("SIGTERM"));

      await superviseWorkers(["salesforce"], options);
      expect(options.runWorker).toHaveBeenCalledOnce();
      expect(options.exit).not.toHaveBeenCalled();
    }
    expect(listen).not.toHaveBeenCalled();
  });

  it("exits 1 when a worker throws or rejects", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    for (const runWorker of [
      () => {
        throw new Error("connection refused");
      },
      async () => {
        throw new Error("connection refused");
      },
    ]) {
      error.mockClear();
      const options = supervision();
      options.runWorker.mockImplementation(runWorker);

      await superviseWorkers(["slack"], options);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ message: "connection refused" }),
        "Error running slack worker."
      );
      expect(options.exit).toHaveBeenCalledExactlyOnceWith(1);
    }
  });

  it("exits 1 when a worker returns before SIGTERM or SIGINT", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const options = supervision();

    await superviseWorkers(["snowflake"], options);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "snowflake worker stopped unexpectedly.",
      }),
      "Error running snowflake worker."
    );
    expect(options.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not exit when a worker returns after SIGTERM or SIGINT", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const options = supervision();
      options.runWorker.mockImplementation(async () => options.send(signal));

      await superviseWorkers(["webcrawler"], options);
      expect(options.exit).not.toHaveBeenCalled();
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("reports ready while every selected worker runs in its own context, then 503 after SIGTERM", async () => {
    const port = await freePort();
    const stop = deferred();
    const started = new Map<WorkerName, FakeTemporalWorker>();
    const allStarted = deferred();
    const options = supervision({
      healthPort: String(port),
      runWorker: async (worker) => {
        started.set(
          worker,
          await createFakeTemporalWorker(
            worker === "zendesk" ? "INITIALIZED" : "RUNNING"
          )
        );
        if (started.size === 2) {
          allStarted.resolve();
        }
        await stop.promise;
      },
    });

    const supervising = superviseWorkers(["dust_project", "zendesk"], options);
    await allStarted.promise;
    expect(await httpStatus(port)).toBe(503);

    const zendesk = started.get("zendesk");
    if (!zendesk) {
      throw new Error("zendesk worker did not start.");
    }
    zendesk.state = "RUNNING";
    expect(await httpStatus(port)).toBe(200);

    options.send("SIGTERM");
    expect(await httpStatus(port)).toBe(503);

    stop.resolve();
    await supervising;
    expect(options.exit).not.toHaveBeenCalled();
    await expect(httpStatus(port)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });
});
