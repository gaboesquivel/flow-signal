import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { events } from "../../../lib/db/schema";
import { recordEvent } from "../../../lib/signal/events";
import { describeWithDatabase, useTestDatabase } from "../support/database";

const agent = { client: "claude-desktop", kind: "agent" as const, ref: "mcp:claude-desktop" };

describeWithDatabase("recordEvent", () => {
  const harness = useTestDatabase();

  it("appends an event with the actor and client", async () => {
    expect(
      await recordEvent(harness.db, {
        actor: agent,
        payload: { attachedTo: "existing" },
        type: "signal.created",
      }),
    ).toBe(true);
    const [row] = await harness.db.select().from(events).where(eq(events.type, "signal.created"));
    expect(row).toMatchObject({
      actorKind: "agent",
      actorRef: "mcp:claude-desktop",
      payload: { attachedTo: "existing", client: "claude-desktop" },
    });
  });

  it("counts a retried request once by dedupe key", async () => {
    const event = { actor: agent, dedupeKey: "signal:key-1", type: "signal.created" as const };
    expect(await recordEvent(harness.db, event)).toBe(true);
    expect(await recordEvent(harness.db, event)).toBe(false);
    const rows = await harness.db.select().from(events).where(eq(events.dedupeKey, "signal:key-1"));
    expect(rows).toHaveLength(1);
  });

  it("writes nothing when the surrounding transaction rolls back", async () => {
    await expect(
      harness.db.transaction(async (tx) => {
        await recordEvent(tx, { actor: agent, dedupeKey: "rolled-back", type: "need.created" });
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    const rows = await harness.db.select().from(events).where(eq(events.dedupeKey, "rolled-back"));
    expect(rows).toHaveLength(0);
  });
});
