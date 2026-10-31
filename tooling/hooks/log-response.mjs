#!/usr/bin/env node
// Appends the agent's response summary, redacted, to its session's prompt log:
// `node tooling/hooks/log-response.mjs <session-tag> "<brief summary>"`. Never fails a turn.
import { logResponse } from "./prompt-log.mjs";

const [session, ...words] = process.argv.slice(2);
try {
  const file = session && logResponse({ session, summary: words.join(" ") });
  console.log(file ? `logged response for session:${session}` : "nothing logged");
} catch (error) {
  console.log(`prompt log unavailable: ${error.message}`);
}
