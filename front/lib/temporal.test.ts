import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientConnect, nativeConnect, clientConstructor, readFile } =
  vi.hoisted(() => ({
    clientConnect: vi.fn(),
    nativeConnect: vi.fn(),
    clientConstructor: vi.fn(),
    readFile: vi.fn(),
  }));

vi.mock("@temporalio/client", () => ({
  Client: class {
    constructor(options: unknown) {
      clientConstructor(options);
    }
  },
  Connection: { connect: clientConnect },
  WorkflowNotFoundError: class extends Error {},
}));

vi.mock("@temporalio/worker", () => ({
  NativeConnection: { connect: nativeConnect },
}));

vi.mock("fs-extra", () => ({
  default: { readFile },
}));

import {
  getConnectionOptions,
  getTemporalClientForNamespace,
  getTemporalWorkerConnection,
} from "./temporal";

const TEMPORAL_ENV_VARIABLES = [
  "TEMPORAL_ADDRESS",
  "TEMPORAL_TLS_MODE",
  "TEMPORAL_CERT_PATH",
  "TEMPORAL_CERT_KEY_PATH",
  "TEMPORAL_TLS_CA_PATH",
  "TEMPORAL_TLS_SERVER_NAME",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_AGENT_NAMESPACE",
  "TEMPORAL_CONNECTORS_NAMESPACE",
  "TEMPORAL_RELOCATION_NAMESPACE",
];

describe("Temporal connection configuration", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    for (const name of TEMPORAL_ENV_VARIABLES) {
      vi.stubEnv(name, undefined);
    }
    readFile.mockImplementation(async (path: string) => Buffer.from(path));
    clientConnect.mockResolvedValue("client-connection");
    nativeConnect.mockResolvedValue("worker-connection");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("preserves development and deployed Temporal Cloud defaults", async () => {
    await expect(getConnectionOptions()).resolves.toEqual({});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TEMPORAL_NAMESPACE", "cloud-namespace");
    vi.stubEnv("TEMPORAL_CERT_PATH", "/cloud.crt");
    vi.stubEnv("TEMPORAL_CERT_KEY_PATH", "/cloud.key");

    await expect(getConnectionOptions()).resolves.toEqual({
      address: "cloud-namespace.tmprl.cloud:7233",
      tls: {
        clientCertPair: {
          crt: Buffer.from("/cloud.crt"),
          key: Buffer.from("/cloud.key"),
        },
      },
    });
  });

  it("uses one plaintext custom address independently of the namespace", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "disabled");
    vi.stubEnv("TEMPORAL_NAMESPACE", "front-local");
    vi.stubEnv("TEMPORAL_AGENT_NAMESPACE", "agent-local");

    await expect(getConnectionOptions("TEMPORAL_NAMESPACE")).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: false,
    });
    await expect(
      getConnectionOptions("TEMPORAL_AGENT_NAMESPACE")
    ).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: false,
    });
  });

  it("configures server TLS with optional CA and verified server name", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "server");
    vi.stubEnv("TEMPORAL_NAMESPACE", "front-local");
    vi.stubEnv("TEMPORAL_TLS_CA_PATH", "/private-ca.pem");
    vi.stubEnv("TEMPORAL_TLS_SERVER_NAME", "temporal.example.internal");

    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: {
        serverNameOverride: "temporal.example.internal",
        serverRootCACertificate: Buffer.from("/private-ca.pem"),
      },
    });
  });

  it("configures mutual TLS with the client pair and optional server trust", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "mutual");
    vi.stubEnv("TEMPORAL_NAMESPACE", "front-local");
    vi.stubEnv("TEMPORAL_CERT_PATH", "/client.crt");
    vi.stubEnv("TEMPORAL_CERT_KEY_PATH", "/client.key");
    vi.stubEnv("TEMPORAL_TLS_CA_PATH", "/private-ca.pem");

    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: {
        clientCertPair: {
          crt: Buffer.from("/client.crt"),
          key: Buffer.from("/client.key"),
        },
        serverNameOverride: undefined,
        serverRootCACertificate: Buffer.from("/private-ca.pem"),
      },
    });
  });

  it.each([
    [{ TEMPORAL_TLS_MODE: "disabled" }, "TEMPORAL_ADDRESS is required"],
    [
      { TEMPORAL_ADDRESS: "temporal.internal:7233" },
      "TEMPORAL_NAMESPACE is required",
    ],
    [
      {
        TEMPORAL_ADDRESS: "temporal.internal:7233",
        TEMPORAL_NAMESPACE: "front-local",
      },
      "TEMPORAL_TLS_MODE is required",
    ],
    [
      {
        TEMPORAL_ADDRESS: "temporal.internal:7233",
        TEMPORAL_NAMESPACE: "front-local",
        TEMPORAL_TLS_MODE: "opportunistic",
      },
      "TEMPORAL_TLS_MODE must be one of",
    ],
    [
      {
        TEMPORAL_ADDRESS: "temporal.internal:7233",
        TEMPORAL_NAMESPACE: "front-local",
        TEMPORAL_TLS_MODE: "disabled",
        TEMPORAL_TLS_CA_PATH: "/ca.pem",
      },
      "cannot be used when TEMPORAL_TLS_MODE=disabled",
    ],
    [
      {
        TEMPORAL_ADDRESS: "temporal.internal:7233",
        TEMPORAL_NAMESPACE: "front-local",
        TEMPORAL_TLS_MODE: "server",
        TEMPORAL_CERT_PATH: "/client.crt",
      },
      "require TEMPORAL_TLS_MODE=mutual",
    ],
    [
      {
        TEMPORAL_ADDRESS: "temporal.internal:7233",
        TEMPORAL_NAMESPACE: "front-local",
        TEMPORAL_TLS_MODE: "mutual",
        TEMPORAL_CERT_PATH: "/client.crt",
      },
      "TEMPORAL_CERT_PATH and TEMPORAL_CERT_KEY_PATH are required",
    ],
  ])("rejects invalid custom configuration %#", async (env, message) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }

    await expect(getConnectionOptions()).rejects.toThrow(message);
  });

  it("passes the resolved custom configuration to API clients and workers", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "disabled");
    vi.stubEnv("TEMPORAL_CONNECTORS_NAMESPACE", "connectors-local");
    vi.stubEnv("TEMPORAL_NAMESPACE", "front-local");

    await getTemporalClientForNamespace("connectors");
    await getTemporalWorkerConnection();

    const expectedConnectionOptions = {
      address: "temporal.internal:7233",
      tls: false,
    };
    expect(clientConnect).toHaveBeenCalledWith(expectedConnectionOptions);
    expect(clientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: "client-connection",
        namespace: "connectors-local",
      })
    );
    expect(nativeConnect).toHaveBeenCalledWith(expectedConnectionOptions);
  });
});
