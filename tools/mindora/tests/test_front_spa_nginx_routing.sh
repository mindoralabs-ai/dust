#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
fixture_dir="$(mktemp -d)"
container_id=""

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$fixture_dir"
}
trap cleanup EXIT

mkdir -p "$fixture_dir/html/share" "$fixture_dir/html/oauth" "$fixture_dir/html/email"
printf '%s\n' '<main>APP_SHELL</main>' > "$fixture_dir/html/index.html"
printf '%s\n' '<main>SHARE_SHELL</main>' > "$fixture_dir/html/share/index.html"
printf '%s\n' '<main>OAUTH_SHELL</main>' > "$fixture_dir/html/oauth/index.html"
printf '%s\n' '<main>EMAIL_SHELL</main>' > "$fixture_dir/html/email/index.html"

container_id="$(
  docker run --detach --rm --publish 127.0.0.1::8080 \
    --volume "$repo_root/dockerfiles/front-spa.nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
    --volume "$fixture_dir/html:/usr/share/nginx/html:ro" \
    nginx:1.29.5-alpine@sha256:1eff5a5f3fcf8431a0abb7eddf5471fec24e5e1905a2581aeacdb07a4479b92b
)"
port="$(docker port "$container_id" 8080/tcp | sed 's/.*://')"
base_url="http://127.0.0.1:$port"

for attempt in {1..40}; do
  if curl --fail --silent "$base_url/healthz" >/dev/null; then
    break
  fi
  if [[ "$attempt" == 40 ]]; then
    docker logs "$container_id"
    exit 1
  fi
  sleep 0.25
done

assert_shell() {
  local path="$1"
  local marker="$2"
  local body
  body="$(curl --fail --silent "$base_url$path")"
  [[ "$body" == *"$marker"* ]] || {
    printf 'expected %s to serve %s, got: %s\n' "$path" "$marker" "$body" >&2
    return 1
  }
}

assert_shell "/share" "SHARE_SHELL"
assert_shell "/share/frame/example-token" "SHARE_SHELL"
assert_shell "/oauth" "OAUTH_SHELL"
assert_shell "/oauth/github/finalize" "OAUTH_SHELL"
assert_shell "/w/example-workspace/oauth/github/setup" "OAUTH_SHELL"
assert_shell "/email" "EMAIL_SHELL"
assert_shell "/email/unsubscribe/example-token" "EMAIL_SHELL"
assert_shell "/w/example-workspace/assistant" "APP_SHELL"

missing_asset_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$base_url/assets/missing.js")"
[[ "$missing_asset_status" == "404" ]] || {
  printf 'expected missing asset to return 404, got %s\n' "$missing_asset_status" >&2
  exit 1
}
