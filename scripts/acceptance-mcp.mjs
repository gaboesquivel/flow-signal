// Spec 001 agent acceptance journey over MCP, on demand (not in CI): public tools as a support
// agent, then Operator tools as a PM agent, against a running instance with a seeded database.
//   SIGNAL_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/acceptance-mcp.mjs
// Needs OPERATOR_SECRET in the environment and live AI for the preview step. Never prints secrets.
// It writes to the database it points at: use the Neon dev branch or a test database, never production.
const base = process.env.SIGNAL_BASE_URL ?? "http://localhost:3000";
const secret = process.env.OPERATOR_SECRET;
let id = 0;
const call = async (path, name, args, auth) => {
  const t = performance.now();
  const r = await fetch(base + path, {
    body: JSON.stringify({
      id: (id += 1),
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "x-mcp-client": "acceptance-agent",
      ...(auth ? { authorization: `Bearer ${secret}` } : {}),
    },
    method: "POST",
  });
  const text = await r.text();
  const ms = Math.round(performance.now() - t);
  const json = JSON.parse(
    text.startsWith("{")
      ? text
      : text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          .slice(5),
  );
  const sc = json.result?.structuredContent;
  return { error: json.error, isError: json.result?.isError, ms, raw: json, sc, status: r.status };
};
let failures = 0;
const step = (n, ok, msg) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}  ${msg}`);
};

const sub = {
  body: "Our CEO wants the KPI dashboard in the board deck every month.",
  title: "Export dashboards to PDF",
};
const p = await call("/api/mcp", "preview_signal", sub);
const top = p.sc?.matches?.[0];
step(
  1,
  p.sc?.ai === "ok" && !!top,
  `preview ai=${p.sc?.ai} ${p.ms}ms; top="${top?.statement}" p=${top?.probability}; draft="${p.sc?.draftNeed?.statement}"; matches=${p.sc?.matches?.length}`,
);
console.log("      reason:", top?.reason);
for (const m of p.sc?.matches ?? []) console.log("      match:", m.probability, m.statement);

const key = `acc-${Date.now()}`;
const s1 = await call("/api/mcp", "submit_signal", {
  ...sub,
  company: "Acme",
  email: "maya@acme.example",
  idempotencyKey: key,
  name: "Maya",
  target: { needId: top?.needId },
  urgency: "high",
  useCase: "monthly board deck",
});
step(2, s1.sc?.attachedTo === "existing", `submit attachedTo=${s1.sc?.attachedTo} ${s1.ms}ms`);
const s2 = await call("/api/mcp", "submit_signal", {
  ...sub,
  company: "Acme",
  email: "maya@acme.example",
  idempotencyKey: key,
  name: "Maya",
  target: { needId: top?.needId },
  urgency: "high",
  useCase: "monthly board deck",
});
step(
  3,
  s2.sc?.signalId === s1.sc?.signalId,
  `retry returns same signal: ${s2.sc?.signalId === s1.sc?.signalId}`,
);

const pub = await call("/api/mcp", "get_need", { needId: top?.needId });
const leaked = JSON.stringify(pub.sc ?? {}).match(/acme|maya/iu);
step(
  "2b",
  !leaked,
  `public need has no Acme/Maya: ${!leaked}; supporters=${pub.sc?.supporterCount}`,
);

const unauth = await call("/api/mcp/operator", "draft_decision_brief", { id: top?.needId }, false);
step(
  "3b",
  unauth.status === 401 || unauth.isError || !!unauth.error,
  `operator call without secret refused (status ${unauth.status})`,
);
const pubTools = await fetch(`${base}/api/mcp`, {
  body: JSON.stringify({ id: (id += 1), jsonrpc: "2.0", method: "tools/list" }),
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
  method: "POST",
}).then((r) => r.text());
step(
  "3c",
  !/publish_decision|merge_needs/u.test(pubTools),
  "operator tools absent from public MCP",
);

const brief = await call("/api/mcp/operator", "draft_decision_brief", { id: top?.needId }, true);
step(
  4,
  !!brief.sc && !brief.isError,
  `draft brief ${brief.ms}ms: ${JSON.stringify(brief.sc ?? brief.raw).slice(0, 160)}`,
);
const list = await call(
  "/api/mcp/operator",
  "list_suggestions",
  { kind: "decision_brief", needId: top?.needId },
  true,
);
const sug = list.sc?.suggestions?.[0];
const res = sug
  ? await call("/api/mcp/operator", "resolve_suggestion", { action: "accept", id: sug.id }, true)
  : {};
step(
  5,
  !!sug && !res.isError,
  `resolve brief: ${sug ? "accepted" : "no suggestion found"} ${JSON.stringify(res.sc ?? res.raw ?? {}).slice(0, 120)}`,
);
const dec = await call(
  "/api/mcp/operator",
  "publish_decision",
  { id: top?.needId, note: "Targeting Q1", status: "planned" },
  true,
);
step(
  6,
  !dec.isError && !!dec.sc,
  `publish decision: ${JSON.stringify(dec.sc ?? dec.raw).slice(0, 140)}`,
);

const token = new URL(s1.sc?.trackingUrl ?? "http://x/my/none").pathname.split("/").pop();
const mine = await call("/api/mcp", "get_my_signals", { token });
const note = JSON.stringify(mine.sc ?? {}).includes("Targeting Q1");
step(7, note, `my signals shows "Targeting Q1": ${note}`);

const met = await call("/api/mcp/operator", "get_metrics", {}, true);
console.log(
  "      metrics prevention:",
  JSON.stringify(
    met.sc?.preventionRate?.overall ?? met.sc?.prevention ?? Object.keys(met.sc ?? {}),
  ).slice(0, 300),
);
step(8, !met.isError && !!met.sc, "get_metrics answered");

if (failures > 0) {
  console.log(`${failures} step(s) failed.`);
  process.exit(1);
}
