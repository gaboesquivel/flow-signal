// Pure helpers for the per-session prompt log (`log-prompt.mjs`, `log-response.mjs`).
// Each session appends to its own Git-ignored `.sessions/<tag>.prompts.log` in the main checkout,
// redacted before anything is written. The tracked prompts.txt is a frozen archive.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Harness-generated turns that arrive through UserPromptSubmit but are not the user's words:
 * subagent hand-backs, background task notifications, side-session, cross-session, and CI events.
 */
const HARNESS_TAGS = [
  "agent-message",
  "task-notification",
  "side-sessions-event",
  "cross-session-message",
  "ci-monitor-event",
];

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;
const MAX_LENGTH = 2000;

/** Content no pattern can redact with confidence: the whole entry is dropped. */
const UNREDACTABLE = /-----BEGIN [A-Z ]*PRIVATE KEY/u;

const SECRET_KEY =
  /\b(?<key>[\w.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|cookie)[\w.-]*)(?<sep>["']?\s*[:=]\s*)(?!\[REDACTED)(?<value>"[^"]*"|'[^']*'|[^\s,;&'"}]+)/giu;

/** Ordered: keyed values first (they keep their key name), then known token shapes. */
const RULES = [
  // Environment assignments: NAME=value, whatever the name.
  // CLI flags that carry a secret: --token X, --password=X, --value X, mysql -p X.
  [
    /(?<flag>--[\w-]*(?:token|password|passwd|secret|api-?key|value)[\w-]*)(?<sep>[ =])(?!\[REDACTED)\S+/giu,
    "$<flag>$<sep>[REDACTED]",
  ],
  [/(?<cmd>\bmysql\w*\b[^\n]*?\s-p)(?<gap>\s?)(?!\[REDACTED)\S+/gu, "$<cmd>$<gap>[REDACTED]"],
  [/(?<flag>\s-u\s+|\s--user[ =])[^\s:]+:\S+/gu, "$<flag>[REDACTED:credentials]"],
  [/\b(?<name>[A-Z][A-Z0-9_]+)=(?!\[REDACTED)(?:"[^"]*"|'[^']*'|\S+)/gu, "$<name>=[REDACTED]"],
  [
    SECRET_KEY,
    (...args) => {
      const { key, sep, value } = args.at(-1);
      return `${key}${sep}${value.startsWith('"') ? '"[REDACTED]"' : "[REDACTED]"}`;
    },
  ],
  // Prose: "password is X", "client_secret X".
  [
    /\b(?<key>password|passwd|passphrase|client_secret|api[_-]?key)(?<gap>\s+(?:is\s+)?)(?!\[REDACTED)[^\s,;]+/giu,
    "$<key>$<gap>[REDACTED]",
  ],
  [/\bBasic\s+[A-Za-z0-9+/]{8,}=*/gu, "Basic [REDACTED:credentials]"],
  [/\bBearer\s+[\w.~+/-]+=*/giu, "Bearer [REDACTED:token]"],
  [/\b(?<scheme>[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]+@/giu, "$<scheme>[REDACTED:credentials]@"],
  [/\bsk-(?:ant-)?[\w-]{16,}/gu, "[REDACTED:api-key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/gu, "[REDACTED:github-token]"],
  [/\b(?:napi|npm|vck)_[A-Za-z0-9]{16,}/gu, "[REDACTED:api-key]"],
  [/\b[rs]k_(?:test|live)_\w{8,}/gu, "[REDACTED:api-key]"],
  [/\bxox[abprs]-[\w-]{10,}/gu, "[REDACTED:slack-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED:aws-key]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/gu, "[REDACTED:jwt]"],
  // Opaque high-entropy strings: mixed case, 3+ digits, 32+ characters (not camelCase names).
  [/\b(?=[\w-]*[A-Z])(?=[\w-]*[a-z])(?=(?:[\w-]*\d){3})[\w-]{32,}/gu, "[REDACTED:token]"],
];

/** Environment names whose values are credentials, wherever those values later appear. */
const SECRET_NAME = /secret|token|password|passwd|key|credential|database_url|postgres/iu;
const MIN_SECRET = 8;
/** A plain word ("postgres") is too common to redact everywhere it appears. */
const PLAIN_WORD = /^[a-z]+$/iu;

const envFileSecrets = (dir) => {
  let names = [];
  try {
    names = readdirSync(dir).filter(
      (name) => /^\.env(?:\..+)?$/u.test(name) && name !== ".env.example",
    );
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      return [
        ...readFileSync(path.join(dir, name), "utf-8").matchAll(
          /^\s*(?:export\s+)?(?<key>[\w.-]+)\s*=\s*(?<value>.*)$/gmu,
        ),
      ].map(({ groups }) => [
        groups.key,
        groups.value.trim().replace(/^(?<quote>["'])(?<inner>.*)\k<quote>$/u, "$<inner>"),
      ]);
    } catch {
      return [];
    }
  });
};

/**
 * Credential values this checkout knows (secret-named variables in `.env*` files under `dirs`,
 * and in the process environment), so a bare pasted value is redacted even without a key.
 */
export const knownSecrets = (dirs = [], env = process.env) => {
  const values = [...Object.entries(env), ...dirs.filter(Boolean).flatMap(envFileSecrets)]
    .map(([key, value]) => [key, String(value ?? "")])
    .filter(
      ([key, value]) =>
        SECRET_NAME.test(key) && value.length >= MIN_SECRET && !PLAIN_WORD.test(value),
    )
    .map(([, value]) => value);
  // Longest first, so a value never leaves a fragment of a longer one that contains it.
  return [...new Set(values)].toSorted((a, b) => b.length - a.length);
};

/** Text with credentials, environment values, and tokens replaced, or null when unsafe to keep. */
export const redact = (text, secrets = []) => {
  const value = String(text ?? "");
  if (UNREDACTABLE.test(value)) return null;
  let out = value;
  for (const secret of secrets) out = out.replaceAll(secret, "[REDACTED:secret]");
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
};

const oneLine = (text, secrets = []) => {
  const redacted = redact(
    String(text ?? "")
      .replaceAll(/\s+/gu, " ")
      .trim(),
    secrets,
  );
  return redacted === null ? "" : redacted.slice(0, MAX_LENGTH);
};

/** The user's own words, redacted and on one line; "" for a harness turn or an unsafe prompt. */
export const userPromptText = (prompt, secrets = []) => {
  const text = String(prompt ?? "")
    .replaceAll(SYSTEM_REMINDER, " ")
    .trim();
  if (HARNESS_TAGS.some((tag) => text.startsWith(`<${tag}`))) return "";
  return oneLine(text, secrets);
};

/** Short, stable tag for a session id (first 8 characters). */
export const sessionTag = (sessionId) =>
  String(sessionId ?? "")
    .replaceAll(/[^a-z0-9]/giu, "")
    .slice(0, 8) || "unknown";

/** The main checkout, so logs outlive the worktree a session ran in. */
export const sharedRoot = (cwd = process.cwd()) => {
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return path.basename(common) === ".git" ? path.dirname(common) : cwd;
  } catch {
    return cwd;
  }
};

export const promptLogFile = (root, session) =>
  path.join(root, ".sessions", `${session}.prompts.log`);

const stamp = (now = new Date()) => now.toISOString().replace(/\.\d{3}Z$/u, "Z");

const append = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  // One appendFile call per entry, so a session's own concurrent writes never interleave.
  appendFileSync(file, text);
};

/**
 * Appends the prompt entry for a hook input (Claude Code UserPromptSubmit, or Cursor
 * beforeSubmitPrompt) and returns `{ file, session }`, or undefined when nothing was logged.
 */
export const logPrompt = (input, { env, now, root } = {}) => {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const base = root || sharedRoot(cwd);
  const prompt = userPromptText(input.prompt, knownSecrets([base, cwd], env));
  if (!prompt) return;
  const session = sessionTag(input.session_id ?? input.conversation_id);
  const file = promptLogFile(base, session);
  const host = input.hook_event_name === "beforeSubmitPrompt" ? "cursor" : "claude-code";
  const worktree = input.cwd ? path.basename(input.cwd) : "unknown";
  const trace = input.transcript_path ? path.basename(input.transcript_path) : "unknown";
  append(
    file,
    `\n[${stamp(now)}] host:${host} model:${input.model || "unknown"} worktree:${worktree} trace:${trace}\nPrompt: ${prompt}\n`,
  );
  return { file, session };
};

/** Appends the agent's response summary to the session's log; returns the file, or undefined. */
export const logResponse = ({ env, now, root, session, summary }) => {
  const base = root || sharedRoot();
  const text = oneLine(summary, knownSecrets([base, process.cwd()], env));
  if (!text) return;
  const file = promptLogFile(base, sessionTag(session));
  append(file, `[${stamp(now)}] Response: ${text}\n`);
  return file;
};
