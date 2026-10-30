import { afterEach, beforeEach, expect, it } from "vitest";

import { POST } from "../../../app/api/[...path]/route";
import { events, signals } from "../../../lib/db/schema";
import { createFakeAi, createUnavailableAi } from "../../../lib/signal/ai/fakes";
import { resetHttpRateLimits } from "../../../lib/signal/adapters/http";
import { configureSignalRuntime, resetSignalRuntime } from "../../../lib/signal/runtime";
import { insertNeed } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

/** Spec 001 → Exposure: public writes are rate and size limited and degrade without AI or a database. */

const post = (path: string, body: unknown, ip = "203.0.113.7") =>
  POST(
    new Request(`http://signal.localhost${path}`, {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      method: "POST",
    }),
  );

const submission = (key: string, needId: string) => ({
  body: "Our CEO wants the KPI dashboard in the board deck every month.",
  email: "maya@acme.example",
  idempotencyKey: key,
  target: { needId },
  title: "Export dashboards to PDF",
});

describeWithDatabase("submission over REST", () => {
  const harness = useTestDatabase();
  beforeEach(async () => {
    resetHttpRateLimits();
    await resetDatabase(harness.db);
    configureSignalRuntime({ ai: createFakeAi(), db: harness.db });
  });
  afterEach(() => configureSignalRuntime({ ai: createFakeAi(), db: harness.db }));

  it("records a REST caller as human by default", async () => {
    const { need } = await insertNeed(harness.db);
    const response = await post("/api/signals", submission("human-0001", need.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attachedTo: "existing", needId: need.id });
    const [signal] = await harness.db.select().from(signals);
    expect(signal).toMatchObject({ actorKind: "human", agentClient: null, channel: "web" });
    const [event] = await harness.db.select().from(events);
    expect(event).toMatchObject({ actorKind: "human", actorRef: "web", type: "signal.created" });
  });

  it("caps submission bodies at 16 KB", async () => {
    const response = await post("/api/signals", { padding: "x".repeat(17 * 1024) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("rate limits submissions per IP", async () => {
    const { need } = await insertNeed(harness.db);
    for (let index = 0; index < 20; index += 1)
      expect((await post("/api/signals", submission(`rate-${index}-0000`, need.id))).status).toBe(
        200,
      );
    const limited = await post("/api/signals", submission("rate-20-0000", need.id));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({
      error: { code: "rate_limited", retryable: true },
    });
    // Another client is not affected.
    expect(
      (await post("/api/signals", submission("rate-other-0000", need.id), "198.51.100.1")).status,
    ).toBe(200);
  });

  it("previews without matches and still submits when AI is unavailable", async () => {
    configureSignalRuntime({ ai: createUnavailableAi() });
    const preview = await post("/api/signals/preview", {
      body: "Dark please.",
      title: "Dark mode",
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ai: "unavailable", matches: [] });

    const submitted = await post("/api/signals", {
      body: "Dark please.",
      email: "nurse@clinic.example",
      idempotencyKey: "no-ai-0001",
      target: { newNeed: { statement: "Night-shift staff need a dark theme so that eyes rest" } },
      title: "Dark mode",
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({ attachedTo: "draft" });
  });

  it("returns database_unavailable without a database", async () => {
    const prior = process.env.DATABASE_URL;
    resetSignalRuntime();
    delete process.env.DATABASE_URL;
    try {
      for (const [path, body] of [
        ["/api/signals/preview", { body: "b", title: "A title" }],
        ["/api/signals", submission("no-db-0001", "4b0e6c1e-8a7d-4f3e-9c2b-1d5a6e7f8a9b")],
      ] as const) {
        const response = await post(path, body);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: "database_unavailable", retryable: true },
        });
      }
    } finally {
      if (prior !== undefined) process.env.DATABASE_URL = prior;
    }
  });
});
