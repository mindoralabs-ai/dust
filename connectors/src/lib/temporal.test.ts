import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientConnect, nativeConnect, clientConstructor, readFile } =
  vi.hoisted(() => ({
    clientConnect: vi.fn(),
    nativeConnect: vi.fn(),
    clientConstructor: vi.fn(),
    readFile: vi.fn(),
  }));

// temporal.ts also imports defaultPayloadConverter and WorkflowNotFoundError, so only the
// connection entry points are replaced.
vi.mock("@temporalio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/client")>()),
  Client: class {
    constructor(options: unknown) {
      clientConstructor(options);
    }
  },
  Connection: { connect: clientConnect },
}));

vi.mock("@temporalio/worker", () => ({
  NativeConnection: { connect: nativeConnect },
}));

vi.mock("fs-extra", () => ({
  default: { readFile },
}));

import {
  getConnectionOptions,
  getTemporalClient,
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

  it("keeps the development default", async () => {
    await expect(getConnectionOptions()).resolves.toEqual({});
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps the deployed Temporal Cloud default", async () => {
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

  it("uses the plaintext custom address unchanged in deployed environments", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "disabled");
    vi.stubEnv("TEMPORAL_NAMESPACE", "dust-connectors");

    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: false,
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("configures server TLS without a private CA", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "server");
    vi.stubEnv("TEMPORAL_NAMESPACE", "dust-connectors");

    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: {
        serverNameOverride: undefined,
        serverRootCACertificate: undefined,
      },
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("configures server TLS with a private CA and verified server name", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "server");
    vi.stubEnv("TEMPORAL_NAMESPACE", "dust-connectors");
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
    vi.stubEnv("TEMPORAL_NAMESPACE", "dust-connectors");
    vi.stubEnv("TEMPORAL_CERT_PATH", "/client.crt");
    vi.stubEnv("TEMPORAL_CERT_KEY_PATH", "/client.key");
    vi.stubEnv("TEMPORAL_TLS_CA_PATH", "/private-ca.pem");
    vi.stubEnv("TEMPORAL_TLS_SERVER_NAME", "temporal.example.internal");

    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: {
        clientCertPair: {
          crt: Buffer.from("/client.crt"),
          key: Buffer.from("/client.key"),
        },
        serverNameOverride: "temporal.example.internal",
        serverRootCACertificate: Buffer.from("/private-ca.pem"),
      },
    });
  });

  it("configures mutual TLS without a private CA or server name", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "mutual");
    vi.stubEnv("TEMPORAL_NAMESPACE", "dust-connectors");
    vi.stubEnv("TEMPORAL_CERT_PATH", "/client.crt");
    vi.stubEnv("TEMPORAL_CERT_KEY_PATH", "/client.key");

    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: {
        clientCertPair: {
          crt: Buffer.from("/client.crt"),
          key: Buffer.from("/client.key"),
        },
        serverNameOverride: undefined,
        serverRootCACertificate: undefined,
      },
    });
  });

  const customAddress = {
    TEMPORAL_ADDRESS: "temporal.internal:7233",
    TEMPORAL_NAMESPACE: "dust-connectors",
  };
  const missingAddressError =
    "TEMPORAL_ADDRESS is required when custom Temporal TLS settings are set";
  const disabledWithTlsError =
    "Temporal TLS certificate settings cannot be used when TEMPORAL_TLS_MODE=disabled";
  const serverWithClientPairError =
    "TEMPORAL_CERT_PATH and TEMPORAL_CERT_KEY_PATH require TEMPORAL_TLS_MODE=mutual";
  const mutualWithoutClientPairError =
    "TEMPORAL_CERT_PATH and TEMPORAL_CERT_KEY_PATH are required when TEMPORAL_TLS_MODE=mutual";

  it.each([
    [{ TEMPORAL_TLS_MODE: "disabled" }, missingAddressError],
    [{ TEMPORAL_TLS_CA_PATH: "/ca.pem" }, missingAddressError],
    [
      { TEMPORAL_TLS_SERVER_NAME: "temporal.example.internal" },
      missingAddressError,
    ],
    [
      { NODE_ENV: "production", TEMPORAL_TLS_MODE: "server" },
      missingAddressError,
    ],
    [
      { TEMPORAL_ADDRESS: "", TEMPORAL_TLS_MODE: "server" },
      missingAddressError,
    ],
    [
      { TEMPORAL_ADDRESS: "temporal.internal:7233" },
      "TEMPORAL_NAMESPACE is required when TEMPORAL_ADDRESS is set",
    ],
    [
      customAddress,
      "TEMPORAL_TLS_MODE is required when TEMPORAL_ADDRESS is set",
    ],
    [
      { ...customAddress, TEMPORAL_TLS_MODE: "" },
      "TEMPORAL_TLS_MODE is required when TEMPORAL_ADDRESS is set",
    ],
    [
      { ...customAddress, TEMPORAL_TLS_MODE: "opportunistic" },
      "TEMPORAL_TLS_MODE must be one of: disabled, server, mutual",
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "disabled",
        TEMPORAL_CERT_PATH: "/client.crt",
      },
      disabledWithTlsError,
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "disabled",
        TEMPORAL_CERT_KEY_PATH: "/client.key",
      },
      disabledWithTlsError,
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "disabled",
        TEMPORAL_TLS_CA_PATH: "/ca.pem",
      },
      disabledWithTlsError,
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "disabled",
        TEMPORAL_TLS_SERVER_NAME: "temporal.example.internal",
      },
      disabledWithTlsError,
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "server",
        TEMPORAL_CERT_PATH: "/client.crt",
      },
      serverWithClientPairError,
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "server",
        TEMPORAL_CERT_KEY_PATH: "/client.key",
      },
      serverWithClientPairError,
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "mutual",
        TEMPORAL_CERT_PATH: "/client.crt",
      },
      mutualWithoutClientPairError,
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "mutual",
        TEMPORAL_CERT_KEY_PATH: "/client.key",
      },
      mutualWithoutClientPairError,
    ],
    [
      { NODE_ENV: "production", TEMPORAL_NAMESPACE: "cloud-namespace" },
      "TEMPORAL_CERT_PATH, TEMPORAL_CERT_KEY_PATH and TEMPORAL_NAMESPACE are required " +
        "when NODE_ENV=production, but not found in the environment",
    ],
  ])("rejects invalid configuration %#", async (env, message) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }

    await expect(getConnectionOptions()).rejects.toThrow(message);
    expect(readFile).not.toHaveBeenCalled();
  });

  // An empty custom setting counts as unset in every check. The server name is still passed on
  // unchanged, so an empty one reaches the connection as an empty string.
  it.each([
    [{ TEMPORAL_ADDRESS: "" }, {}],
    [
      {
        NODE_ENV: "production",
        TEMPORAL_ADDRESS: "",
        TEMPORAL_NAMESPACE: "cloud-namespace",
        TEMPORAL_CERT_PATH: "/cloud.crt",
        TEMPORAL_CERT_KEY_PATH: "/cloud.key",
      },
      {
        address: "cloud-namespace.tmprl.cloud:7233",
        tls: {
          clientCertPair: {
            crt: Buffer.from("/cloud.crt"),
            key: Buffer.from("/cloud.key"),
          },
        },
      },
    ],
    [
      {
        TEMPORAL_TLS_MODE: "",
        TEMPORAL_TLS_CA_PATH: "",
        TEMPORAL_TLS_SERVER_NAME: "",
      },
      {},
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "disabled",
        TEMPORAL_TLS_CA_PATH: "",
        TEMPORAL_TLS_SERVER_NAME: "",
      },
      { address: "temporal.internal:7233", tls: false },
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "server",
        TEMPORAL_TLS_CA_PATH: "",
        TEMPORAL_TLS_SERVER_NAME: "",
      },
      {
        address: "temporal.internal:7233",
        tls: {
          serverNameOverride: undefined,
          serverRootCACertificate: undefined,
        },
      },
    ],
    [
      {
        ...customAddress,
        TEMPORAL_TLS_MODE: "mutual",
        TEMPORAL_CERT_PATH: "/client.crt",
        TEMPORAL_CERT_KEY_PATH: "/client.key",
        TEMPORAL_TLS_CA_PATH: "",
        TEMPORAL_TLS_SERVER_NAME: "",
      },
      {
        address: "temporal.internal:7233",
        tls: {
          clientCertPair: {
            crt: Buffer.from("/client.crt"),
            key: Buffer.from("/client.key"),
          },
          serverNameOverride: undefined,
          serverRootCACertificate: undefined,
        },
      },
    ],
  ])("treats an empty custom setting as unset in checks %#", async (env, expected) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }

    await expect(getConnectionOptions()).resolves.toEqual(expected);
    expect(readFile).not.toHaveBeenCalledWith("");
  });

  it("reads the custom settings again on every connection setup", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "disabled");
    vi.stubEnv("TEMPORAL_NAMESPACE", "dust-connectors");
    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.internal:7233",
      tls: false,
    });

    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.other:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "server");
    vi.stubEnv("TEMPORAL_TLS_CA_PATH", "/other-ca.pem");
    vi.stubEnv("TEMPORAL_TLS_SERVER_NAME", "temporal.other.internal");
    await expect(getConnectionOptions()).resolves.toEqual({
      address: "temporal.other:7233",
      tls: {
        serverNameOverride: "temporal.other.internal",
        serverRootCACertificate: Buffer.from("/other-ca.pem"),
      },
    });

    vi.stubEnv("TEMPORAL_ADDRESS", undefined);
    vi.stubEnv("TEMPORAL_TLS_MODE", undefined);
    vi.stubEnv("TEMPORAL_TLS_CA_PATH", undefined);
    vi.stubEnv("TEMPORAL_TLS_SERVER_NAME", undefined);
    await expect(getConnectionOptions()).resolves.toEqual({});
  });

  it("passes the custom configuration to the API client and the worker", async () => {
    vi.stubEnv("TEMPORAL_ADDRESS", "temporal.internal:7233");
    vi.stubEnv("TEMPORAL_TLS_MODE", "disabled");
    vi.stubEnv("TEMPORAL_NAMESPACE", "dust-connectors");

    await getTemporalClient();
    const workerConnection = await getTemporalWorkerConnection();

    const expectedConnectionOptions = {
      address: "temporal.internal:7233",
      tls: false,
    };
    expect(clientConnect).toHaveBeenCalledWith(expectedConnectionOptions);
    expect(clientConstructor).toHaveBeenCalledWith({
      connection: "client-connection",
      namespace: "dust-connectors",
    });
    expect(nativeConnect).toHaveBeenCalledWith(expectedConnectionOptions);
    expect(workerConnection).toEqual({
      connection: "worker-connection",
      namespace: "dust-connectors",
    });
  });
});
