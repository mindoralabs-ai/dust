import { request } from "node:http";
import { createServer, Server } from "node:net";
import {
  launchJoinChannelWorkflow,
  launchSlackWebhookEventWorkflow,
} from "@connectors/connectors/slack/temporal/client";
import {
  isKnownConnectorProvider,
  PROVIDER_GROUPS,
} from "@connectors/lib/enabled_connector_providers";
import logger from "@connectors/logger/logger";
import type { Worker } from "@temporalio/worker";
import { Runtime } from "@temporalio/worker/lib/runtime";
import { compileOptions } from "@temporalio/worker/lib/runtime-options";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTemporalWorker, runInWorkerContext } from "./bundle_helper";
import type { WorkerShutdownSignal } from "./worker_health";
import {
  parseWorkerHealthPort,
  startWorkerHealthServer,
  superviseWorkers,
  WORKER_SHUTDOWN_SIGNALS,
  workerSelectionArgs,
} from "./worker_health";
import type { WorkerName } from "./worker_registry";
import {
  ALL_WORKERS,
  WORKER_PROVIDERS,
  workerFunctions,
} from "./worker_registry";

type TemporalWorkerState = ReturnType<Worker["getState"]>;
type FakeTemporalWorker = {
  state: TemporalWorkerState;
  getState: () => TemporalWorkerState;
};

const { pendingTemporalWorkers, temporalWorkerOptions, startedWorkflows } =
  vi.hoisted(() => ({
    pendingTemporalWorkers: new Array<object>(),
    temporalWorkerOptions: new Array<{ taskQueue?: string }>(),
    startedWorkflows: new Array<{ taskQueue?: string }>(),
  }));

// Only Worker.create is replaced: readiness is computed by the real bundle_helper tracking.
vi.mock("@temporalio/worker", () => ({
  Worker: {
    create: async (options: { taskQueue?: string }) => {
      temporalWorkerOptions.push(options);
      return pendingTemporalWorkers.shift();
    },
  },
}));

// Worker.create never loads workflow code, so the real workers need no workflow bundle.
vi.mock("./bundle_helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundle_helper")>()),
  getWorkflowConfig: () => ({ workflowsPath: "worker-health-test" }),
}));

// The real workers connect, and the real launch functions start workflows, through these.
vi.mock("@connectors/lib/temporal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@connectors/lib/temporal")>()),
  getTemporalWorkerConnection: async () => ({
    connection: "worker-connection",
    namespace: "worker-health-test",
  }),
  getTemporalClient: async () => ({
    workflow: {
      start: async (_workflow: unknown, options: { taskQueue?: string }) => {
        startedWorkflows.push(options);
      },
    },
  }),
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
  workerProviders = WORKER_PROVIDERS,
  enabledProviders,
  healthPort,
}: {
  runWorker?: (worker: WorkerName) => Promise<void>;
  workerProviders?: typeof WORKER_PROVIDERS;
  enabledProviders?: string;
  healthPort?: string;
} = {}) {
  const listeners = new Map<string, () => void>();
  return {
    runWorker: vi.fn(runWorker),
    workerProviders,
    enabledProviders,
    healthPort,
    onceSignal: vi.fn((signal: string, listener: () => void) => {
      listeners.set(signal, listener);
    }),
    exit: vi.fn(),
    // Like `process.once`, a listener runs for the first signal only.
    send: (signal: WorkerShutdownSignal) => {
      const listener = listeners.get(signal);
      listeners.delete(signal);
      listener?.();
    },
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

  it("does not exit when a worker returns after any signal the Temporal runtime shuts down on", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    for (const signal of WORKER_SHUTDOWN_SIGNALS) {
      const options = supervision();
      options.runWorker.mockImplementation(async () => options.send(signal));

      await superviseWorkers(["webcrawler"], options);
      expect(options.exit).not.toHaveBeenCalled();
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps every selected worker running until the last one returns after SIGQUIT or SIGUSR2", async () => {
    for (const signal of ["SIGQUIT", "SIGUSR2"] as const) {
      const drained = deferred();
      const options = supervision({
        runWorker: async (worker) => {
          // Temporal drains every Worker on the signal; the second one finishes later.
          if (worker === "bigquery") {
            options.send(signal);
          } else {
            await drained.promise;
          }
        },
      });

      const supervising = superviseWorkers(["bigquery", "confluence"], options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(options.exit).not.toHaveBeenCalled();

      drained.resolve();
      await supervising;
      expect(options.exit).not.toHaveBeenCalled();
    }
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

  it("does not exit on SIGTERM or SIGINT before any selected worker runs, and reports 503 until the worker returns", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const runs: [WorkerName, "SIGTERM" | "SIGINT"][] = [
      ["google_drive", "SIGTERM"],
      ["intercom", "SIGINT"],
    ];
    for (const [worker, signal] of runs) {
      const port = await freePort();
      const connecting = deferred();
      const connected = deferred();
      const running = deferred();
      const stop = deferred();
      const options = supervision({
        healthPort: String(port),
        runWorker: async () => {
          connecting.resolve();
          await connected.promise;
          await createFakeTemporalWorker("RUNNING");
          running.resolve();
          await stop.promise;
        },
      });

      const supervising = superviseWorkers([worker], options);
      await connecting.promise;
      options.send(signal);
      expect(options.exit).not.toHaveBeenCalled();

      // The worker finishes starting after the signal.
      connected.resolve();
      await running.promise;
      expect(await httpStatus(port)).toBe(503);

      stop.resolve();
      await supervising;
      expect(options.exit).not.toHaveBeenCalled();
      await expect(httpStatus(port)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("does not exit on SIGTERM while only some selected workers run", async () => {
    const stop = deferred();
    const allCreated = deferred();
    let created = 0;
    const options = supervision({
      runWorker: async (worker) => {
        await createFakeTemporalWorker(
          worker === "microsoft" ? "RUNNING" : "INITIALIZED"
        );
        created += 1;
        if (created === 2) {
          allCreated.resolve();
        }
        await stop.promise;
      },
    });

    const supervising = superviseWorkers(["microsoft", "notion"], options);
    await allCreated.promise;
    options.send("SIGTERM");
    expect(options.exit).not.toHaveBeenCalled();

    stop.resolve();
    await supervising;
    expect(options.exit).not.toHaveBeenCalled();
  });
});

// superviseWorkers leaves signal-driven shutdown to Temporal's runtime, which must also stop a
// Worker whose run() registers its shutdown callback after the signal.
describe("Temporal runtime shutdown hook", () => {
  it("shuts down on exactly the signals superviseWorkers marks shutdown on, as the SDK default does", () => {
    // start_worker.ts pins the runtime to WORKER_SHUTDOWN_SIGNALS. Matching the SDK default keeps
    // upstream's graceful drain on each of them; an SDK upgrade that changes it fails here.
    expect(
      compileOptions({ shutdownSignals: [...WORKER_SHUTDOWN_SIGNALS] })
        .shutdownSignals
    ).toEqual([...WORKER_SHUTDOWN_SIGNALS]);
    expect(compileOptions({}).shutdownSignals).toEqual([
      ...WORKER_SHUTDOWN_SIGNALS,
    ]);
  });

  it("runs a shutdown callback registered after shutdown started", async () => {
    const shuttingDown = {
      state: "SHUTTING_DOWN",
      shutdownSignalCallbacks: new Set<() => void>(),
    };
    const callback = vi.fn();

    Runtime.prototype.registerShutdownSignalCallback.call(
      shuttingDown,
      callback
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe("worker provider allowlist", () => {
  // Every provider that some worker does work for.
  const workerProviders = [...new Set(Object.values(WORKER_PROVIDERS).flat())];

  it("maps every registered worker to known connector providers", () => {
    expect(Object.keys(WORKER_PROVIDERS).sort()).toEqual(
      [...ALL_WORKERS].sort()
    );
    for (const worker of ALL_WORKERS as WorkerName[]) {
      const providers = WORKER_PROVIDERS[worker];
      expect(providers.length).toBeGreaterThan(0);
      expect(new Set(providers).size).toBe(providers.length);
      expect(providers.every((p) => isKnownConnectorProvider(p))).toBe(true);
    }
  });

  it("groups the providers of every worker that does work for more than one", () => {
    for (const worker of ALL_WORKERS as WorkerName[]) {
      const providers = WORKER_PROVIDERS[worker];
      if (providers.length > 1) {
        expect(Object.entries(PROVIDER_GROUPS)).toContainEqual([
          worker,
          providers,
        ]);
      }
    }
    for (const [worker, group] of Object.entries(PROVIDER_GROUPS)) {
      expect(ALL_WORKERS).toContain(worker);
      expect(Object.entries(WORKER_PROVIDERS)).toContainEqual([worker, group]);
    }
  });

  it("starts a worker when the list enables every provider it does work for", async () => {
    for (const worker of ALL_WORKERS as WorkerName[]) {
      const allowed = supervision({
        enabledProviders: WORKER_PROVIDERS[worker].join(","),
      });
      allowed.runWorker.mockImplementation(async () => allowed.send("SIGTERM"));
      await superviseWorkers([worker], allowed);
      expect(allowed.runWorker).toHaveBeenCalledExactlyOnceWith(worker);
      expect(allowed.exit).not.toHaveBeenCalled();
    }
  });

  it("refuses a worker when the list enables none of the providers it does work for", async () => {
    for (const worker of ALL_WORKERS as WorkerName[]) {
      const providers = WORKER_PROVIDERS[worker];
      const refused = supervision({
        enabledProviders: workerProviders
          .filter((p) => !providers.includes(p))
          .join(","),
      });
      await expect(superviseWorkers([worker], refused)).rejects.toThrow(
        `CONNECTORS_ENABLED_PROVIDERS does not enable every provider of these workers: ${worker} (${providers.join(", ")}).`
      );
      expect(refused.runWorker).not.toHaveBeenCalled();
    }
  });

  // Each worker of WORKER_PROVIDERS with several providers has them in one provider group, which no
  // valid list enables in part, so this worker map is made up.
  it("refuses a worker when the list enables only some of the providers it does work for", async () => {
    const options = supervision({
      workerProviders: { ...WORKER_PROVIDERS, notion: ["notion", "github"] },
      enabledProviders: "notion",
    });

    await expect(superviseWorkers(["notion"], options)).rejects.toThrow(
      "CONNECTORS_ENABLED_PROVIDERS does not enable every provider of these workers: notion (notion, github)."
    );
    expect(options.onceSignal).not.toHaveBeenCalled();
    expect(options.runWorker).not.toHaveBeenCalled();
  });

  // The API starts channel joins for slack_bot connectors and webhook events for the slack
  // provider on the Slack queue.
  it("runs the worker of the Slack queue under a list that enables slack and slack_bot", async () => {
    await launchJoinChannelWorkflow(1, "C1", "join-only");
    await launchSlackWebhookEventWorkflow("T1", "Ev1", {
      type: "channel_left",
    });
    const apiQueues = startedWorkflows.map(({ taskQueue }) => taskQueue);
    expect(apiQueues).toHaveLength(2);
    expect(new Set(apiQueues).size).toBe(1);

    temporalWorkerOptions.length = 0;
    const options = supervision({
      enabledProviders: "slack,slack_bot",
      runWorker: (worker) => workerFunctions[worker](),
    });
    pendingTemporalWorkers.push({
      run: async () => options.send("SIGTERM"),
    });

    await superviseWorkers(["slack"], options);
    expect(options.exit).not.toHaveBeenCalled();
    expect(temporalWorkerOptions.map(({ taskQueue }) => taskQueue)).toEqual([
      apiQueues[0],
    ]);
  });

  it("refuses the Slack worker and every other worker under a list that enables only one Slack provider, before anything starts", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const cases: [string, string][] = [
      ["slack", "slack but not slack_bot"],
      ["slack_bot", "slack_bot but not slack"],
      ["dust_project,slack_bot", "slack_bot but not slack"],
    ];
    const selections: WorkerName[][] = [
      ["slack"],
      ["dust_project"],
      ["dust_project", "notion"],
    ];
    for (const [enabledProviders, partial] of cases) {
      for (const workers of selections) {
        const options = supervision({
          enabledProviders,
          healthPort: String(await freePort()),
        });
        listen.mockClear();

        await expect(superviseWorkers(workers, options)).rejects.toThrow(
          `Invalid connectors configuration: CONNECTORS_ENABLED_PROVIDERS enables ${partial}: slack and slack_bot share the slack worker and must be enabled together`
        );
        expect(options.onceSignal).not.toHaveBeenCalled();
        expect(listen).not.toHaveBeenCalled();
        expect(options.runWorker).not.toHaveBeenCalled();
        expect(options.exit).not.toHaveBeenCalled();
      }
    }
  });

  it("refuses a selection with any worker the list does not enable before anything starts", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const cases: [string, WorkerName[], string][] = [
      ["slack,slack_bot", ["dust_project"], "dust_project (dust_project)"],
      ["slack,slack_bot", ["slack", "notion"], "notion (notion)"],
      [
        "dust_project",
        ["dust_project", "notion_garbage_collector", "slack"],
        "notion_garbage_collector (notion); slack (slack, slack_bot)",
      ],
    ];
    for (const [enabledProviders, workers, refused] of cases) {
      const options = supervision({
        enabledProviders,
        healthPort: String(await freePort()),
      });
      listen.mockClear();

      await expect(superviseWorkers(workers, options)).rejects.toThrow(
        `CONNECTORS_ENABLED_PROVIDERS does not enable every provider of these workers: ${refused}.`
      );
      expect(options.onceSignal).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      expect(options.runWorker).not.toHaveBeenCalled();
      expect(options.exit).not.toHaveBeenCalled();
    }
  });

  it("refuses a malformed list before anything starts", async () => {
    for (const enabledProviders of [
      "",
      "dust_project,",
      "dust_project,unknown_provider",
      "dust_project,dust_project",
    ]) {
      const options = supervision({ enabledProviders });

      await expect(superviseWorkers(["dust_project"], options)).rejects.toThrow(
        /^Invalid connectors configuration: CONNECTORS_ENABLED_PROVIDERS /
      );
      expect(options.onceSignal).not.toHaveBeenCalled();
      expect(options.runWorker).not.toHaveBeenCalled();
    }
  });

  it("starts every selected worker when the list is unset", async () => {
    const options = supervision();
    options.runWorker.mockImplementation(async () => options.send("SIGTERM"));

    await superviseWorkers(ALL_WORKERS as WorkerName[], options);
    expect(options.runWorker.mock.calls.map(([worker]) => worker)).toEqual(
      ALL_WORKERS
    );
  });
});
