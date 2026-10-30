import { afterEach, describe, expect, it, vi } from "vitest";

import { isOperatorAssistantEnabled } from "../../../lib/flags/operator-assistant";
import {
  actionPreviewSchema,
  writeEventTypes,
} from "../../../lib/signal/domain/assistant-action-contract";
import type { ActionPreview } from "../../../lib/signal/domain/assistant-action-contract";
import { describeStale, fingerprint } from "../../../lib/signal/domain/assistant-actions";
import { operations } from "../../../lib/signal/operations/registry";
import { isPlanned } from "../../../lib/signal/operations/types";

const preview: ActionPreview = {
  blocks: [],
  editable: [],
  lines: [{ label: "Signals moving", value: "7" }],
  needs: [{ id: "n1", role: "source", statement: "Admins need CSV export" }],
  notes: ["Two open suggestions close."],
  title: "Merge 2 needs",
};

describe("assistant action contract", () => {
  it("parses a preview", () => {
    expect(actionPreviewSchema.parse(preview)).toEqual(preview);
  });

  it("fingerprints what the PM saw, not notes or editable fields", () => {
    const same = fingerprint(preview);
    expect(fingerprint({ ...preview, notes: [] })).toBe(same);
    expect(
      fingerprint({ ...preview, editable: [{ key: "note", kind: "longtext", label: "Note" }] }),
    ).toBe(same);
    expect(fingerprint({ ...preview, lines: [{ label: "Signals moving", value: "8" }] })).not.toBe(
      same,
    );
    expect(
      fingerprint({ ...preview, blocks: [{ code: "conflict", message: "Need was merged" }] }),
    ).not.toBe(same);
  });

  it("counts writes only from event types write operations record", () => {
    expect(writeEventTypes).not.toContain("report.viewed");
    expect(writeEventTypes).not.toContain("assistant.action_confirmed");
    expect(
      operations.filter((operation) => !isPlanned(operation) && operation.effects === "write"),
    ).not.toHaveLength(0);
  });
});

describe("describeStale", () => {
  const from = "11111111-1111-4111-8111-111111111111";
  const into = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";
  const shown: ActionPreview = {
    ...preview,
    needs: [
      { id: from, role: "source", statement: "Admins need CSV export" },
      { id: into, role: "target", statement: "Export reports" },
    ],
  };

  it("names needs by the statements the card showed, never by id", () => {
    expect(describeStale(`Need ${from} is already merged.`, shown)).toBe(
      "“Admins need CSV export” is already merged.",
    );
    expect(describeStale(`No need with id ${into}.`, shown)).toBe(
      "“Export reports” no longer exists.",
    );
    expect(describeStale(`Merge ${other} was already undone.`, shown)).toBe(
      "The merge of “Admins need CSV export” into “Export reports” was already undone.",
    );
    expect(describeStale(`Need ${into} was merged into ${other} afterwards.`, shown)).toBe(
      "“Export reports” was merged into another one afterwards.",
    );
    expect(describeStale(`No suggestion with id ${other}.`, preview)).toBe(
      "This suggestion no longer exists.",
    );
  });
});

describe("OPERATOR_ASSISTANT flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is on only for `on`", () => {
    vi.stubEnv("OPERATOR_ASSISTANT", "on");
    expect(isOperatorAssistantEnabled()).toBe(true);
    vi.stubEnv("OPERATOR_ASSISTANT", " ON ");
    expect(isOperatorAssistantEnabled()).toBe(true);
    vi.stubEnv("OPERATOR_ASSISTANT", "1");
    expect(isOperatorAssistantEnabled()).toBe(false);
    vi.stubEnv("OPERATOR_ASSISTANT", "");
    expect(isOperatorAssistantEnabled()).toBe(false);
  });
});
