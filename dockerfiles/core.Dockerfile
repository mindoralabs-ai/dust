# Build stage — full Rust toolchain + cmake (needed for sentencepiece)
# Keep the builder on bookworm: the runtime stage is bookworm-slim and binaries must not link
# against a newer glibc than the runtime provides.
FROM rust:1.94.1-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS builder

RUN apt-get update && apt-get install -y cmake && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY /core/ .

ARG CARGO_BUILD_JOBS=2
RUN --mount=type=cache,id=core-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=core-cargo-git,target=/usr/local/cargo/git \
    cargo build --jobs "$CARGO_BUILD_JOBS" --release --bin core-api --bin sqlite-worker --bin check_table --bin init_db

# Runtime stage — only the compiled binaries + minimal system libs
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS core

# libstdc++6: required by V8 (via deno_core) C++ runtime
# ca-certificates: required for TLS connections to GCS, Elasticsearch, Qdrant, etc.
RUN apt-get update && \
  apt-get install -y libstdc++6 ca-certificates && \
  rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/core-api /usr/local/bin/core-api
COPY --from=builder /app/target/release/sqlite-worker /usr/local/bin/sqlite-worker
COPY --from=builder /app/target/release/check_table /usr/local/bin/check_table
COPY --from=builder /app/target/release/init_db /usr/local/bin/init_db

ARG COMMIT_HASH
ARG COMMIT_HASH_LONG
ARG DD_GIT_REPOSITORY_URL=https://github.com/dust-tt/dust
ARG DD_GIT_COMMIT_SHA=${COMMIT_HASH_LONG}
ENV DD_GIT_REPOSITORY_URL=${DD_GIT_REPOSITORY_URL}
ENV DD_GIT_COMMIT_SHA=${DD_GIT_COMMIT_SHA}

EXPOSE 3001

CMD ["core-api"]
