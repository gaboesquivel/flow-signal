// Pure helpers for the prompt log hook (`log-prompt.mjs`, spec 010).
import { appendFileSync } from "node:fs";
import path from "node:path";

/**
 * Harness-generated turns that arrive through UserPromptSubmit but are not the user's words:
 * subagent hand-backs, background task notifications, side-session and CI monitor events.
 */
const HARNESS_TAGS = [
  "agent-message",
  "task-notification",
  "side-sessions-event",
  "ci-monitor-event",
];

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;

/** The user's own words in a prompt, or "" for a harness turn or a reminder-only prompt. */
export const userPromptText = (prompt) => {
  const text = String(prompt ?? "")
    .replaceAll(SYSTEM_REMINDER, " ")
    .trim();
  if (HARNESS_TAGS.some((tag) => text.startsWith(`<${tag}`))) return "";
  return text.replaceAll(/\s+/gu, " ").trim().slice(0, 500);
};

/** Short, stable tag for a Claude Code session id (first 8 characters). */
export const sessionTag = (sessionId) =>
  String(sessionId ?? "")
    .replaceAll(/[^a-z0-9]/giu, "")
    .slice(0, 8) || "unknown";

/** One prompts.txt entry: `[<utc>] session:<tag>` then `Prompt: <text>`. */
export const formatEntry = ({ now = new Date(), prompt, session }) => {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/u, "Z");
  return `\n[${stamp}] session:${session}\nPrompt: ${prompt}\n`;
};

/**
 * Appends the entry for a hook input (one appendFile call, so concurrent sessions never
 * interleave inside an entry) and returns the session tag, or undefined when nothing was logged.
 */
export const logPrompt = (input, { now, root } = {}) => {
  const prompt = userPromptText(input.prompt);
  if (!prompt) return;
  const session = sessionTag(input.session_id);
  const dir = root || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  appendFileSync(path.join(dir, "prompts.txt"), formatEntry({ now, prompt, session }));
  return session;
};
