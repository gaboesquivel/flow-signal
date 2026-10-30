import { beforeEach, expect, it } from "vitest";

import { createUnavailableAi, createFakeAi } from "../../lib/signal/ai/fakes";
import { resetHttpRateLimits } from "../../lib/signal/adapters/http";
import type { SignalDb } from "../../lib/signal/db";
import { configureSignalRuntime } from "../../lib/signal/runtime";
import { createInProcessSignalClient } from "../../lib/signal/server-client";
import { insertNeed, insertSubmitter, insertTheme } from "./support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "./support/database";

/** The pages' client end to end: in-process REST, real database, fake AI (task 07). */

const maya = {
  body: "Our CEO wants the KPI dashboard in the board deck every month.",
  company: "Acme",
  email: "maya@acme.example",
  name: "Maya",
  title: "Export dashboards to PDF",
};

describeWithDatabase("in-process Signal client", () => {
  const harness = useTestDatabase();
  const client = createInProcessSignalClient({ forwardedFor: "203.0.113.9" });

  beforeEach(async () => {
    resetHttpRateLimits();
    await resetDatabase(harness.db);
    configureSignalRuntime({ ai: createFakeAi(), db: harness.db });
  });

  it("serves the board, a need, a submission, its retry, and My signals", async () => {
    const theme = await insertTheme(harness.db, { name: "Reporting" });
    const other = await insertSubmitter(harness.db, { email: "lee@globex.example" });
    const { need } = await insertNeed(harness.db, {
      signals: [{ body: "Globex private words", submitterId: other.id }],
      solutions: ["PDF export"],
      statement: "Executives need to share dashboard snapshots outside the product",
      themeId: theme.id,
    });

    const board = await client.searchNeeds({ theme: "Reporting" });
    expect(board.ok && board.data.needs.map((item) => item.id)).toEqual([need.id]);
    expect(JSON.stringify(board)).not.toMatch(/globex|Globex private words/u);

    const submitted = await client.submitSignal({
      ...maya,
      idempotencyKey: "ui-attempt-0001",
      target: { needId: need.id },
      urgency: "high",
      useCase: "monthly board deck",
    });
    expect(submitted).toMatchObject({
      data: { attachedTo: "existing", needId: need.id },
      ok: true,
    });
    const retry = await client.submitSignal({
      ...maya,
      idempotencyKey: "ui-attempt-0001",
      target: { needId: need.id },
      urgency: "high",
      useCase: "monthly board deck",
    });
    expect(retry.ok && submitted.ok && retry.data.signalId).toBe(
      submitted.ok && submitted.data.signalId,
    );

    const read = await client.getNeed({ id: need.id });
    expect(read.ok && read.data.supporterCount).toBe(2);
    expect(JSON.stringify(read)).not.toMatch(/acme|maya|globex/iu);

    const token = submitted.ok
      ? new URL(submitted.data.trackingUrl).pathname.split("/").at(-1)
      : "";
    const mine = await client.getMySignals({ token: token! });
    expect(mine).toMatchObject({
      data: {
        signals: [{ body: maya.body, need: { id: need.id }, useCase: "monthly board deck" }],
      },
      ok: true,
    });
    expect(JSON.stringify(mine)).not.toMatch(/globex/iu);
  });

  it("reports preview without AI as unavailable, and a missing need as not_found", async () => {
    configureSignalRuntime({ ai: createUnavailableAi(), db: harness.db });
    expect(await client.previewSignal({ body: maya.body, title: maya.title })).toMatchObject({
      data: { ai: "unavailable", matches: [] },
      ok: true,
    });
    expect(await client.getNeed({ id: "00000000-0000-4000-8000-000000000000" })).toMatchObject({
      error: { code: "not_found", status: 404 },
      ok: false,
    });
  });

  it("reports database_unavailable when the database is unreachable", async () => {
    const unreachable = new Proxy({} as SignalDb, {
      get: () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    });
    configureSignalRuntime({ db: unreachable });
    try {
      expect(await client.searchNeeds({})).toMatchObject({
        error: { code: "database_unavailable", retryable: true, status: 503 },
        ok: false,
      });
    } finally {
      configureSignalRuntime({ ai: createFakeAi(), db: harness.db });
    }
  });
});
