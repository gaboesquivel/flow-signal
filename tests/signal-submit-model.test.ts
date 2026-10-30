import { describe, expect, it } from "vitest";

import {
  attemptFingerprint,
  needOptions,
  previewQuery,
  splitTitle,
  toSubmitInput,
  trackingLinkFor,
} from "../app/submit/submit-model";
import type { ChosenNeed, PreviewMatch, SubmitFields } from "../app/submit/submit-model";

/** `/submit` form rules (task 07): what is previewed and what is submitted. */

const fields: SubmitFields = {
  body: " Our CEO wants the KPI dashboard in the board deck every month. ",
  company: " ",
  email: " maya@acme.example ",
  name: "",
  newStatement: " Executives need dashboard snapshots in board decks ",
  title: " Export dashboards to PDF ",
  urgency: "high",
  useCase: "monthly board deck",
};

const need = (needId: string): ChosenNeed => ({
  demandBand: "high",
  needId,
  statement: `Need ${needId}`,
  status: "open",
  supporterCount: 11,
});

describe("submit form model", () => {
  it("previews once the title has 3 characters", () => {
    expect(previewQuery("PD", "body")).toBeUndefined();
    expect(previewQuery(" PDF ", " body ")).toEqual({ body: "body", title: "PDF" });
  });

  it("keeps a chosen need visible after new matches arrive, without duplicates", () => {
    const match = { ...need("a"), probability: 0.9, reason: "same" } as PreviewMatch;
    expect(needOptions([match], [need("a"), need("b"), undefined]).map((n) => n.needId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("adds my voice to a need with my words, or starts a new need with the statement", () => {
    const keys = { idempotencyKey: "web-1234567890", previewId: "pv_1" };
    expect(toSubmitInput(fields, undefined, keys)).toBeUndefined();
    expect(toSubmitInput(fields, { kind: "need", needId: "n1" }, keys)).toEqual({
      body: "Our CEO wants the KPI dashboard in the board deck every month.",
      company: undefined,
      email: "maya@acme.example",
      idempotencyKey: "web-1234567890",
      name: undefined,
      previewId: "pv_1",
      target: { needId: "n1" },
      title: "Export dashboards to PDF",
      urgency: "high",
      useCase: "monthly board deck",
    });
    expect(toSubmitInput(fields, { kind: "new" }, keys)?.target).toEqual({
      newNeed: { statement: "Executives need dashboard snapshots in board decks" },
    });
  });

  it("treats the same content as the same attempt", () => {
    const input = toSubmitInput(fields, { kind: "new" }, { idempotencyKey: "k" })!;
    const { idempotencyKey: _a, ...content } = input;
    expect(attemptFingerprint(content)).toBe(attemptFingerprint({ ...content }));
    expect(attemptFingerprint(content)).not.toBe(attemptFingerprint({ ...content, title: "x" }));
  });

  it("shows the tracking link on the current origin and trims split titles", () => {
    expect(trackingLinkFor("http://localhost:3000/my/abc_DEF-123", "https://signal.example")).toBe(
      "https://signal.example/my/abc_DEF-123",
    );
    expect(splitTitle("x".repeat(250))).toHaveLength(200);
  });
});
