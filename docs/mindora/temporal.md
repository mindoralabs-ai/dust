# Temporal connection configuration

Dust uses its existing Temporal Cloud configuration unless `TEMPORAL_ADDRESS` is set. In Cloud
mode, deployed environments derive the endpoint from each namespace and use the client certificate
pair in `TEMPORAL_CERT_PATH` and `TEMPORAL_CERT_KEY_PATH`. Development keeps the Temporal SDK's
local defaults.

`TEMPORAL_ADDRESS` selects one custom Temporal server for API clients and workers. Set the relevant
namespace variable separately (`TEMPORAL_NAMESPACE`, `TEMPORAL_AGENT_NAMESPACE`,
`TEMPORAL_CONNECTORS_NAMESPACE`, or `TEMPORAL_RELOCATION_NAMESPACE`) and set exactly one explicit
`TEMPORAL_TLS_MODE`:

- `disabled`: plaintext. Use this only on a private network. TLS certificate, CA, and server-name
  settings are rejected.
- `server`: TLS with server certificate verification. `TEMPORAL_TLS_CA_PATH` can supply a private
  CA and `TEMPORAL_TLS_SERVER_NAME` can supply the hostname that the certificate must verify.
- `mutual`: server verification plus a required client certificate pair from `TEMPORAL_CERT_PATH`
  and `TEMPORAL_CERT_KEY_PATH`. The private CA and verified server-name settings remain optional.

Do not expose an unauthenticated Temporal endpoint to a public network. Plaintext mode provides no
transport encryption or server authentication and is limited to trusted private-network routing.

Example for a local or private-network Temporal service:

```sh
TEMPORAL_ADDRESS=temporal.internal:7233
TEMPORAL_TLS_MODE=disabled
TEMPORAL_NAMESPACE=mindora
```

An incomplete or contradictory custom configuration fails during connection setup. It does not
silently fall back to Temporal Cloud.
