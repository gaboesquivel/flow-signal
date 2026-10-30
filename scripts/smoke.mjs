// `pnpm smoke [--live]`: HTTP-level pre-merge check of the key surfaces against a running server
// (SMOKE_BASE_URL, default https://signal.localhost; Operator via OPERATOR_SECRET). Read-only: the
// preview check sends an invalid title (no model call, nothing recorded), My signals reads an
// unknown token, and the assistant check sends an empty history. `--live` adds one cheap model
// call: generate_report, which saves nothing. Exits 1 when any check fails.
const live = process.argv.includes("--live");
const base = (process.env.SMOKE_BASE_URL || "https://signal.localhost").replace(/\/+$/u, "");
const secret = process.env.OPERATOR_SECRET?.trim() ?? "";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 60_000;

const results = [];
let cookie = "";

const request = async (path, { body, headers = {}, method = "GET", timeout = TIMEOUT_MS } = {}) => {
  const started = Date.now();
  const init = {
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  // Signal operations answer `{ error: { code } }`; Operator access answers `{ code }`.
  const code = json?.error?.code ?? json?.code;
  return { code, json, ms: Date.now() - started, response, text };
};

/** Runs one check; `verify` returns a short note or throws with the reason it failed. */
const check = async (name, run) => {
  try {
    const { ms, note } = await run();
    results.push({ ms, name, note, ok: true });
    console.log(`ok    ${name} (${ms} ms)${note ? ` — ${note}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
};

const expectStatus = (result, ...statuses) => {
  const { status } = result.response;
  if (!statuses.includes(status)) {
    const code = result.code ? ` ${result.code}` : "";
    throw new Error(`expected ${statuses.join(" or ")}, got ${status}${code}`);
  }
  return result;
};

/** The AI Gateway balance in dollars from AI_GATEWAY_API_KEY, or null when unknown. */
const gatewayBalance = async () => {
  if (!process.env.AI_GATEWAY_API_KEY?.trim()) return null;
  try {
    const { createGateway } = await import("@ai-sdk/gateway");
    const credits = await createGateway().getCredits();
    const balance = Number(credits.balance);
    return Number.isFinite(balance) ? balance : null;
  } catch {
    return null;
  }
};

/** A one-line reason for a failed model call, naming an exhausted AI Gateway balance plainly. */
const describeModelFailure = async ({ code, json, response, text }) => {
  const message = String(json?.error?.message ?? json?.message ?? text).slice(0, 200);
  const balance = await gatewayBalance();
  if (response.status === 402 || (balance !== null && balance <= 0))
    return `AI Gateway out of credits (balance $${(balance ?? 0).toFixed(2)}): top up, then rerun --live`;
  if (code === "ai_unavailable" || code === "chat_unavailable")
    return `model unavailable (${code}): check AI_GATEWAY_API_KEY — ${message}`;
  return `expected 200, got ${response.status}${code ? ` ${code}` : ""} — ${message}`;
};

const page = (path) => async () => {
  const result = expectStatus(await request(path), 200);
  if (!/<html/iu.test(result.text)) throw new Error("200 without an HTML document");
  return { ms: result.ms };
};

console.log(`smoke: ${base}${live ? " (live)" : ""}`);

// Public surfaces
await check("public board /", page("/"));
await check("submit page /submit", page("/submit"));
let needId;
await check("needs API GET /api/needs", async () => {
  const result = expectStatus(await request("/api/needs?limit=1"), 200);
  if (!Array.isArray(result.json?.needs)) throw new Error("no needs array");
  needId = result.json.needs[0]?.id;
  return { ms: result.ms, note: needId ? `first need ${needId}` : "board is empty" };
});
if (needId) await check("need page /needs/:id", page(`/needs/${encodeURIComponent(needId)}`));
await check("submit preview API POST /api/signals/preview", async () => {
  // A too-short title fails validation before any model call or record.
  const result = expectStatus(
    await request("/api/signals/preview", { body: { body: "", title: "x" }, method: "POST" }),
    400,
  );
  if (result.code !== "validation_failed") throw new Error(`code ${result.code}`);
  return { ms: result.ms, note: "route up (validation_failed, no model call)" };
});
await check("My signals API GET /api/my-signals/:token", async () => {
  const result = expectStatus(await request(`/api/my-signals/smoke-${"0".repeat(26)}`), 404);
  if (result.code !== "not_found") throw new Error(`code ${result.code}`);
  return { ms: result.ms, note: "unknown token → not_found (database reachable)" };
});

// Operator: closed without a session
await check("operator closed: /operator/needs redirects", async () => {
  const result = expectStatus(await request("/operator/needs"), 307, 308);
  const location = result.response.headers.get("location") ?? "";
  if (!location.includes("/operator/access")) throw new Error(`redirects to ${location}`);
  return { ms: result.ms, note: "→ /operator/access" };
});
await check("operator closed: POST /api/operator/assistant → 401", async () => {
  const result = expectStatus(
    await request("/api/operator/assistant", { body: { messages: [] }, method: "POST" }),
    401,
  );
  return { ms: result.ms, note: result.code };
});

// Operator: sign in, then the console
if (secret.length < 16) {
  results.push({ name: "operator sign-in", ok: false });
  console.log("FAIL  operator sign-in — OPERATOR_SECRET is not set (min 16 characters)");
} else {
  await check("operator sign-in POST /api/operator/session", async () => {
    const result = expectStatus(
      await request("/api/operator/session", { body: { token: secret }, method: "POST" }),
      200,
    );
    const session = result.response.headers.get("set-cookie")?.split(";")[0];
    if (!session) throw new Error("no session cookie");
    cookie = session;
    return { ms: result.ms };
  });
  if (cookie) {
    await check("operator page /operator/needs", page("/operator/needs"));
    await check("operator page /operator/reports", page("/operator/reports"));
    await check("operator page /operator/metrics", page("/operator/metrics"));
    await check("operator page /operator/chat", page("/operator/chat"));
    await check("report dataset API GET /api/operator/report-datasets/needs", async () => {
      const result = expectStatus(await request("/api/operator/report-datasets/needs"), 200);
      if (!Array.isArray(result.json?.columns) || !Array.isArray(result.json?.rows))
        throw new Error("no columns/rows");
      return { ms: result.ms, note: `${result.json.rows.length} rows` };
    });
    await check("assistant flag POST /api/operator/assistant (empty history)", async () => {
      // 400 = flag on (body rejected before the model); 404 = flag off.
      const result = expectStatus(
        await request("/api/operator/assistant", { body: { messages: [] }, method: "POST" }),
        400,
        404,
      );
      const on = result.response.status === 400;
      const wanted = process.env.OPERATOR_ASSISTANT?.trim().toLowerCase() === "on";
      const note = `assistant ${on ? "on" : "off"}`;
      return {
        ms: result.ms,
        note: on === wanted ? note : `${note} (local env says ${wanted ? "on" : "off"})`,
      };
    });
    if (live)
      await check("live: POST /api/operator/reports/generate", async () => {
        const result = await request("/api/operator/reports/generate", {
          body: { prompt: "Count of needs by status" },
          method: "POST",
          timeout: 120_000,
        });
        if (result.response.status !== 200) throw new Error(await describeModelFailure(result));
        const blocks = result.json?.report?.blocks?.length ?? 0;
        if (blocks === 0) throw new Error("report has no blocks");
        return {
          ms: result.ms,
          note: `${blocks} blocks, ${result.json.warnings?.length ?? 0} warnings`,
        };
      });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\nsmoke: ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((result) => result.name).join(", ")}` : ""}`,
);
process.exitCode = failed.length ? 1 : 0;
