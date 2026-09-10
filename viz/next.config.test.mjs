import assert from "node:assert/strict";
import test from "node:test";

const originalNodeEnv = process.env.NODE_ENV;
const originalAllowedOrigin = process.env.ALLOWED_VISUALIZATION_ORIGIN;

async function loadContentSecurityPolicy({ nodeEnv, allowedOrigin }) {
  process.env.NODE_ENV = nodeEnv;
  if (allowedOrigin === undefined) {
    delete process.env.ALLOWED_VISUALIZATION_ORIGIN;
  } else {
    process.env.ALLOWED_VISUALIZATION_ORIGIN = allowedOrigin;
  }

  const configUrl = new URL("./next.config.mjs", import.meta.url);
  configUrl.searchParams.set("test", crypto.randomUUID());
  const { default: config } = await import(configUrl.href);
  const headers = await config.headers();
  return headers[0].headers.find(
    ({ key }) => key === "Content-Security-Policy"
  ).value;
}

test.after(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalAllowedOrigin === undefined) {
    delete process.env.ALLOWED_VISUALIZATION_ORIGIN;
  } else {
    process.env.ALLOWED_VISUALIZATION_ORIGIN = originalAllowedOrigin;
  }
});

test("production CSP includes exact configured origins and upstream defaults", async () => {
  const csp = await loadContentSecurityPolicy({
    nodeEnv: "production",
    allowedOrigin:
      "https://growth.example.com, https://tenant.example.com:8443",
  });

  assert.match(csp, /frame-ancestors [^;]*https:\/\/dust\.tt/);
  assert.match(csp, /frame-ancestors [^;]*https:\/\/\*\.preview\.dust\.tt/);
  assert.match(csp, /frame-ancestors [^;]*https:\/\/growth\.example\.com/);
  assert.match(csp, /frame-ancestors [^;]*https:\/\/tenant\.example\.com:8443/);
});

test("development CSP accepts an exact HTTP origin", async () => {
  const csp = await loadContentSecurityPolicy({
    nodeEnv: "development",
    allowedOrigin: "http://localhost:4011",
  });

  assert.match(csp, /frame-ancestors [^;]*http:\/\/localhost:4011/);
});

for (const invalidOrigin of [
  "http://growth.example.com",
  "https://*.example.com",
  "https://growth.example.com/path",
  "https://growth.example.com/",
  "https://user@example.com",
  "'self'",
]) {
  test(`production config rejects ${invalidOrigin}`, async () => {
    await assert.rejects(
      loadContentSecurityPolicy({
        nodeEnv: "production",
        allowedOrigin: invalidOrigin,
      }),
      /Invalid ALLOWED_VISUALIZATION_ORIGIN|must contain exact HTTPS origins/
    );
  });
}
