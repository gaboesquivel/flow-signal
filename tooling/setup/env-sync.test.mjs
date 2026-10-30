import assert from "node:assert/strict";
import test from "node:test";

import { readLocalDefaults, syncLocalDefaults } from "./env-sync.mjs";

const example = [
  "AI_GATEWAY_API_KEY=",
  "# OPERATOR_SECRET=",
  "# >>> local defaults: `pnpm env:sync` adds these to .env.local when missing",
  "# Experimental assistant",
  "OPERATOR_ASSISTANT=on",
  "SOME_FLAG=1",
  "# <<< local defaults",
  "DATABASE_URL=postgres://localhost/signal_dev",
  "",
].join("\n");

test("readLocalDefaults reads only the marked section", () => {
  assert.deepEqual(
    readLocalDefaults(example).map(({ key }) => key),
    ["OPERATOR_ASSISTANT", "SOME_FLAG"],
  );
  assert.deepEqual(readLocalDefaults("A=1\n"), []);
});

test("syncLocalDefaults appends missing keys only", () => {
  const { added, text } = syncLocalDefaults({
    exampleText: example,
    localText: "AI_GATEWAY_API_KEY=secret\nSOME_FLAG=0",
  });
  assert.deepEqual(added, ["OPERATOR_ASSISTANT"]);
  assert.ok(text.startsWith("AI_GATEWAY_API_KEY=secret\nSOME_FLAG=0\n"));
  assert.match(text, /\nOPERATOR_ASSISTANT=on\n$/u);
  assert.doesNotMatch(text, /SOME_FLAG=1/u);
});

test("syncLocalDefaults leaves empty and commented-out keys alone", () => {
  for (const localText of [
    "OPERATOR_ASSISTANT=\nSOME_FLAG=1\n",
    "# OPERATOR_ASSISTANT=on\nSOME_FLAG=1\n",
  ]) {
    const result = syncLocalDefaults({ exampleText: example, localText });
    assert.deepEqual(result.added, []);
    assert.equal(result.text, localText);
  }
});
