import assert from "node:assert/strict";
import test from "node:test";

import { applyDataPreset, readDatabaseUrl, upsertEnvLine } from "./data-preset.mjs";

const json = (body, status = 200) => ({
  json: () => body,
  ok: status >= 200 && status < 300,
  status,
});

test("readDatabaseUrl ignores a blank value", () => {
  assert.equal(readDatabaseUrl("DATABASE_URL=\nAI_GATEWAY_API_KEY=\n"), undefined);
  assert.equal(
    readDatabaseUrl("DATABASE_URL=neon-connection-fixture\n"),
    "neon-connection-fixture",
  );
});

test("upsertEnvLine keeps an existing value", () => {
  const existing = upsertEnvLine({
    key: "DATABASE_URL",
    text: "DATABASE_URL=kept\n",
    value: "new",
  });
  assert.equal(existing.changed, false);
  assert.equal(existing.text, "DATABASE_URL=kept\n");
  const blank = upsertEnvLine({
    key: "DATABASE_URL",
    text: "DATABASE_URL=\n",
    value: "neon-connection-fixture",
  });
  assert.equal(blank.changed, true);
  assert.match(blank.text, /DATABASE_URL=neon-connection-fixture\n$/u);
  const added = upsertEnvLine({
    key: "DATABASE_URL",
    text: "AI=1\n",
    value: "neon-connection-fixture",
  });
  assert.equal(added.changed, true);
  assert.match(added.text, /DATABASE_URL=neon-connection-fixture\n$/u);
});

test("minimal preset does not call the network", async () => {
  let called = false;
  const result = await applyDataPreset({
    fetchImpl: () => {
      called = true;
      return json({});
    },
    preset: "minimal",
    projectName: "acme-app",
  });
  assert.equal(result.ok, true);
  assert.equal(result.preset, "minimal");
  assert.equal(called, false);
});

test("neon preset fails closed without authorization", async () => {
  let called = false;
  const result = await applyDataPreset({
    fetchImpl: () => {
      called = true;
      return json({});
    },
    preset: "neon",
    projectName: "acme-app",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /authorization/u);
  assert.equal(called, false);
});

test("neon preset reuses a linked project and database", async () => {
  let called = false;
  const result = await applyDataPreset({
    fetchImpl: () => {
      called = true;
      return json({});
    },
    local: { databaseUrl: "neon-connection-fixture", vercelProjectId: "prj_1" },
    preset: "neon",
    projectName: "acme-app",
  });
  assert.equal(result.reused, true);
  assert.equal(result.changed, false);
  assert.equal(result.databaseUrl, undefined);
  assert.equal(called, false);
});

test("neon preset creates once and does not echo secrets in errors", async () => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const href = String(url);
    if (href.includes("/v9/projects/acme-app") && !href.includes("/env")) return json({}, 404);
    if (href.endsWith("/v10/projects") || href.includes("/v10/projects?"))
      return json({ accountId: "team_1", id: "prj_1" });
    if (href.includes("/connection_uri")) return json({}, 404);
    if (href.endsWith("/projects?limit=100")) return json({ projects: [] });
    if (href.endsWith("/api/v2/projects"))
      return json({ connection_uris: [{ connection_uri: "neon-connection-fixture" }] });
    if (href.includes("/env")) return json({ envs: [] });
    return json({ error: "secret neon-connection-fixture leaked" }, 500);
  };
  const result = await applyDataPreset({
    env: { NEON_API_KEY: "neon-key", VERCEL_TOKEN: "vercel-token" },
    fetchImpl,
    preset: "neon",
    projectName: "acme-app",
  });
  assert.equal(result.ok, true);
  assert.equal(result.databaseUrl, "neon-connection-fixture");
  assert.equal(result.vercel.projectId, "prj_1");
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 3);
  const again = await applyDataPreset({
    env: { NEON_API_KEY: "neon-key", VERCEL_TOKEN: "vercel-token" },
    fetchImpl,
    local: { databaseUrl: result.databaseUrl, vercelProjectId: result.vercel.projectId },
    preset: "neon",
    projectName: "acme-app",
  });
  assert.equal(again.reused, true);
  const failed = await applyDataPreset({
    env: { NEON_API_KEY: "neon-key", VERCEL_TOKEN: "vercel-token" },
    fetchImpl: () => json({ connection_uri: "neon-connection-fixture" }, 500),
    preset: "neon",
    projectName: "acme-app",
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.error, /neon-connection-fixture/u);
});
