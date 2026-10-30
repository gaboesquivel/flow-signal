import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatEntry, logPrompt, sessionTag, userPromptText } from "./prompt-log.mjs";

test("userPromptText skips harness turns", () => {
  for (const prompt of [
    '<agent-message from="a0c4"> [Subagent hand-back] done',
    "<task-notification> <task-id>a0c4</task-id> </task-notification>",
    "<side-sessions-event>x</side-sessions-event>",
    "<ci-monitor-event>checks passed</ci-monitor-event>",
    "<system-reminder>only a reminder</system-reminder>\n  ",
    "   ",
  ])
    assert.equal(userPromptText(prompt), "", prompt);
});

test("userPromptText keeps the user's words without reminders", () => {
  assert.equal(
    userPromptText("<system-reminder>ctx</system-reminder>\nship   it\nnow"),
    "ship it now",
  );
  assert.equal(userPromptText("x".repeat(600)).length, 500);
});

test("sessionTag shortens the session id", () => {
  assert.equal(sessionTag("e210b054-abe1-402c-974a-28700d01b4a5"), "e210b054");
  assert.equal(sessionTag(undefined), "unknown");
});

test("logPrompt appends one tagged entry and skips harness turns", () => {
  const root = mkdtempSync(path.join(tmpdir(), "prompt-log-"));
  const now = new Date("2026-10-30T22:01:04.123Z");
  assert.equal(
    logPrompt({ prompt: "<task-notification>x</task-notification>", session_id: "s1" }, { root }),
    undefined,
  );
  assert.equal(
    logPrompt({ prompt: "build it", session_id: "abcdef1234" }, { now, root }),
    "abcdef12",
  );
  assert.equal(
    readFileSync(path.join(root, "prompts.txt"), "utf-8"),
    formatEntry({ now, prompt: "build it", session: "abcdef12" }),
  );
  assert.equal(
    formatEntry({ now, prompt: "build it", session: "abcdef12" }),
    "\n[2026-10-30T22:01:04Z] session:abcdef12\nPrompt: build it\n",
  );
});
