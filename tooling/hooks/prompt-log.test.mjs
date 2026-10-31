import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  logPrompt,
  logResponse,
  promptLogFile,
  redact,
  sessionTag,
  sharedRoot,
  userPromptText,
} from "./prompt-log.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const now = new Date("2026-10-31T20:01:04.123Z");
const tempRoot = () => mkdtempSync(path.join(tmpdir(), "prompt-log-"));

test("userPromptText skips harness turns", () => {
  for (const prompt of [
    '<agent-message from="a0c4"> [Subagent hand-back] done',
    "<task-notification> <task-id>a0c4</task-id> </task-notification>",
    "<side-sessions-event>x</side-sessions-event>",
    "<ci-monitor-event>checks passed</ci-monitor-event>",
    '<cross-session-message from="local_1">x</cross-session-message>',
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
  assert.equal(userPromptText("x".repeat(3000)).length, 2000);
});

test("sessionTag shortens the session id", () => {
  assert.equal(sessionTag("e210b054-abe1-402c-974a-28700d01b4a5"), "e210b054");
  assert.equal(sessionTag(undefined), "unknown");
});

test("redact replaces credentials and keeps their key names", () => {
  const cases = [
    ["DATABASE_URL=postgres://signal:hunter2@db.neon.tech/signal", "DATABASE_URL=[REDACTED]"],
    ['export AI_GATEWAY_API_KEY="vck_live_value"', "export AI_GATEWAY_API_KEY=[REDACTED]"],
    ['{"apiKey": "abc123", "name": "signal"}', '{"apiKey": "[REDACTED]", "name": "signal"}'],
    ["client_secret: s3cr3t then ship it", "client_secret: [REDACTED] then ship it"],
    [
      "curl -H 'Authorization: Bearer abc.def-123'",
      "curl -H 'Authorization: Bearer [REDACTED:token]'",
    ],
    ["use sk-ant-api03-AbCdEf0123456789xyz now", "use [REDACTED:api-key] now"],
    ["token ghp_0123456789abcdefABCDEF0123 leaked", "token [REDACTED:github-token] leaked"],
    ["key AKIAABCDEFGHIJKLMNOP here", "key [REDACTED:aws-key] here"],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl ok",
      "jwt [REDACTED:jwt] ok",
    ],
    [
      "connect to postgres://user:pa55@host:5432/db",
      "connect to postgres://[REDACTED:credentials]@host:5432/db",
    ],
    ["opaque Xk9Tq2LmZr8Vb4Nw7Ys1Pd6Hc3Jf5Gt0 value", "opaque [REDACTED:token] value"],
    ["gh auth login --token abc123secret", "gh auth login --token [REDACTED]"],
    ["vercel env add FOO --value=supersecret", "vercel env add FOO --value=[REDACTED]"],
    ["mysql -u root -p hunter2 db", "mysql -u root -p [REDACTED] db"],
    ["curl -u admin:hunter2 https://x", "curl -u [REDACTED:credentials] https://x"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [REDACTED:credentials]"],
    ["my password is hunter2", "my password is [REDACTED]"],
    ["client_secret abc123", "client_secret [REDACTED]"],
    ["neon napi_abcdefghij0123456789xyz ok", "neon [REDACTED:api-key] ok"],
    ["npm npm_abcdefghij0123456789xyz ok", "npm [REDACTED:api-key] ok"],
    ["slack xoxb-1234567890-abcdefghij ok", "slack [REDACTED:slack-token] ok"],
    ["stripe sk_test_51Habcdefghij ok", "stripe [REDACTED:api-key] ok"],
    ["https://user:p@ss@host.com/x", "https://[REDACTED:credentials]@host.com/x"],
    ["?token=abc&page=2", "?token=[REDACTED]&page=2"],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test("redact leaves ordinary delivery text alone", () => {
  for (const text of [
    "ship it",
    "merge 5b715b78e7c02a2cfd18491f02464768d3d03db9 on spec/048-delivery-lifecycle",
    "session e210b054-abe1-402c-974a-28700d01b4a5 author: gabo",
    "see https://github.com/gaboesquivel/flow-signal/pull/31",
    "render ChatMessageListItem2Renderer.tsx via handleGenerativeUi2Preview",
    "pnpm -p vitest run tests/mcp/route.test.ts",
  ])
    assert.equal(redact(text), text);
});

test("redact drops what it cannot redact with confidence", () => {
  assert.equal(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA=="), null);
});

test("each session writes its own redacted log under the shared root", () => {
  const root = tempRoot();
  const first = logPrompt(
    {
      cwd: "/repo/.claude/worktrees/flow-alignment",
      model: "claude-opus-5-5",
      prompt: "set DATABASE_URL=postgres://u:p@h/db then build it",
      session_id: "abcdef12-3456",
      transcript_path: "/x/abcdef12-3456.jsonl",
    },
    { now, root },
  );
  const second = logPrompt({ prompt: "ship it", session_id: "99887766-aaaa" }, { now, root });

  assert.deepEqual(first, { file: promptLogFile(root, "abcdef12"), session: "abcdef12" });
  assert.equal(second.file, path.join(root, ".sessions", "99887766.prompts.log"));
  assert.equal(
    readFileSync(first.file, "utf-8"),
    "\n[2026-10-31T20:01:04Z] host:claude-code model:claude-opus-5-5 worktree:flow-alignment trace:abcdef12-3456.jsonl\n" +
      "Prompt: set DATABASE_URL=[REDACTED] then build it\n",
  );
  assert.match(readFileSync(second.file, "utf-8"), /model:unknown .*\nPrompt: ship it\n$/u);
});

test("harness turns and unredactable prompts write nothing", () => {
  const root = tempRoot();
  assert.equal(
    logPrompt({ prompt: "<task-notification>x</task-notification>" }, { root }),
    undefined,
  );
  assert.equal(
    logPrompt({ prompt: "-----BEGIN RSA PRIVATE KEY----- abc", session_id: "s1" }, { root }),
    undefined,
  );
});

test("logResponse appends a redacted response to the session's log", () => {
  const root = tempRoot();
  const { file } = logPrompt({ prompt: "build it", session_id: "abcdef12" }, { now, root });
  assert.equal(
    logResponse({ now, root, session: "abcdef12", summary: "set token=abc; opened PR" }),
    file,
  );
  assert.match(
    readFileSync(file, "utf-8"),
    /\n\[2026-10-31T20:01:04Z\] Response: set token=\[REDACTED\]; opened PR\n$/u,
  );
  assert.equal(
    logResponse({ root, session: "abcdef12", summary: "-----BEGIN PRIVATE KEY-----" }),
    undefined,
  );
});

test("logs live in the main checkout and Git ignores them", () => {
  assert.equal(sharedRoot(path.join(repoRoot, "tooling")), sharedRoot(repoRoot));
  assert.ok(!sharedRoot(repoRoot).includes(`${path.sep}.claude${path.sep}worktrees`));
  execFileSync("git", ["check-ignore", "-q", ".sessions/abcdef12.prompts.log"], { cwd: repoRoot });
});
