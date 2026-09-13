# Mindora visualization embedding

Set `ALLOWED_VISUALIZATION_ORIGIN` to the exact HTTPS origin that embeds visualization pages. Use a
comma-separated list when more than one production origin is required:

```sh
ALLOWED_VISUALIZATION_ORIGIN=https://growth.example.com,https://tenant.example.com
```

Production values must be origins only: no path, trailing slash, credentials, query, fragment, or
wildcard. Invalid values stop Next configuration evaluation. Development also permits exact HTTP
origins for local frontends.

Next resolves `headers()` while building the visualization app. The variable must therefore be set
for the visualization image build, for example with Docker's
`--build-arg ALLOWED_VISUALIZATION_ORIGIN=https://growth.example.com`; changing only the runtime
environment of an already-built image does not update its Content Security Policy. When the build
argument is omitted, the image retains the upstream environment-specific frame-ancestor defaults.
The embedding page must use the same origins for its existing `postMessage` check.
