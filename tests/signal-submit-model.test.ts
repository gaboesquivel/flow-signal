import { describe, expect, it } from "vitest";

import {
  MY_LINK_KEY,
  attemptFingerprint,
  checkOptions,
  describeReady,
  forgetLink,
  linkOutcome,
  previewKey,
  readRememberedLink,
  rememberLink,
  splitTitle,
  toSubmitInput,
  tokenFromTrackingUrl,
  trackingLinkFor,
  visibleStep,
} from "../app/submit/submit-model";
import type { ChosenNeed, PreviewMatch, SubmitFields } from "../app/submit/submit-model";

/** `/submit` wizard rules (spec 006 task 04): what is checked, shown, and submitted. */

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
  it("continues from Describe once there is a title of 3 characters and some words", () => {
    expect(describeReady("PD", "body")).toBe(false);
    expect(describeReady("PDF", "   ")).toBe(false);
    expect(describeReady(" PDF ", " body ")).toBe(true);
  });

  it("checks again only when the words changed, not their surrounding spaces", () => {
    expect(previewKey("PD", "body")).toBeUndefined();
    const first = previewKey("Export PDF", "For the board pack");
    expect(previewKey(" Export PDF ", "For the board pack\n")).toBe(first);
    expect(previewKey("Export PDF", "For the board pack monthly")).not.toBe(first);
    expect(previewKey("Export a PDF", "For the board pack")).not.toBe(first);
  });

  it("lists up to three matches, a need the person came from first", () => {
    const match = (id: string) =>
      ({ ...need(id), probability: 0.9, reason: `why ${id}` }) as PreviewMatch;
    expect(
      checkOptions([match("a"), match("b"), match("c"), match("d")]).map((n) => n.needId),
    ).toEqual(["a", "b", "c"]);
    expect(
      checkOptions([match("a"), match("b"), match("c")], need("b")).map((n) => n.needId),
    ).toEqual(["b", "a", "c"]);
    // The pinned need keeps its reason when the check also found it.
    expect(checkOptions([match("b")], need("b"))[0]?.reason).toBe("why b");
    expect(checkOptions([], need("z")).map((n) => n.needId)).toEqual(["z"]);
  });

  it("shows a step only when what it needs is there; Done stays until starting over", () => {
    const empty = { choice: undefined, described: false, done: false };
    expect(visibleStep("check", empty)).toBe("describe");
    expect(visibleStep("details", { ...empty, described: true })).toBe("check");
    expect(visibleStep("check", { ...empty, described: true })).toBe("check");
    expect(visibleStep("details", { ...empty, choice: { kind: "new" }, described: true })).toBe(
      "details",
    );
    expect(visibleStep("done", { ...empty, choice: { kind: "new" }, described: true })).toBe(
      "details",
    );
    expect(visibleStep("describe", { ...empty, described: true })).toBe("describe");
    expect(visibleStep("check", { choice: { kind: "new" }, described: true, done: true })).toBe(
      "done",
    );
  });

  it("adds my voice to a need with my words, or starts a new need with the statement", () => {
    const keys = { idempotencyKey: "web-1234567890", previewId: "pv_1", trackingToken: undefined };
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

  it("files onto a remembered My signals link when one is given", () => {
    const token = "abcdefghijklmnop_QRS-123";
    const input = toSubmitInput(
      fields,
      { kind: "new" },
      { idempotencyKey: "k", trackingToken: token },
    );
    expect(input?.trackingToken).toBe(token);
    expect(toSubmitInput(fields, { kind: "new" }, { idempotencyKey: "k" })).not.toHaveProperty(
      "trackingToken",
    );
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

/** A Storage stand-in; `broken` throws like a browser with storage blocked. */
const memoryStorage = (initial: Record<string, string> = {}, broken = false) => {
  const items = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw new DOMException("blocked", "SecurityError");
  };
  return {
    getItem: (key: string) => {
      guard();
      return items.get(key) ?? null;
    },
    items,
    removeItem: (key: string) => {
      guard();
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      guard();
      items.set(key, value);
    },
  };
};

describe("remembered My signals link", () => {
  const token = "abcdefghijklmnop_QRS-123";

  it("reads the token from a tracking URL and ignores anything else", () => {
    expect(tokenFromTrackingUrl(`https://signal.example/my/${token}`)).toBe(token);
    expect(tokenFromTrackingUrl("https://signal.example/needs/abc")).toBeUndefined();
    expect(tokenFromTrackingUrl("https://signal.example/my/short")).toBeUndefined();
    expect(tokenFromTrackingUrl("not a url")).toBeUndefined();
  });

  it("remembers, reads, and forgets the link under signal.myLink", () => {
    const storage = memoryStorage();
    expect(readRememberedLink(storage)).toBeUndefined();
    rememberLink(storage, token);
    expect(storage.items.get(MY_LINK_KEY)).toBe(token);
    expect(MY_LINK_KEY).toBe("signal.myLink");
    expect(readRememberedLink(storage)).toBe(token);
    forgetLink(storage);
    expect(readRememberedLink(storage)).toBeUndefined();
  });

  it("ignores a stored value that is not a token", () => {
    expect(readRememberedLink(memoryStorage({ [MY_LINK_KEY]: "<script>" }))).toBeUndefined();
  });

  it("works without storage: blocked or missing storage never throws", () => {
    const broken = memoryStorage({ [MY_LINK_KEY]: token }, true);
    expect(readRememberedLink(broken)).toBeUndefined();
    expect(() => rememberLink(broken, token)).not.toThrow();
    expect(() => forgetLink(broken)).not.toThrow();
    expect(readRememberedLink(undefined)).toBeUndefined();
    expect(() => rememberLink(undefined, token)).not.toThrow();
  });

  it("says whether the submission joined the link, started one, or replaced a dead one", () => {
    expect(linkOutcome({ linkReused: true }, token)).toBe("reused");
    expect(linkOutcome({ linkReused: false }, undefined)).toBe("new");
    expect(linkOutcome({ linkReused: false }, token)).toBe("replaced");
  });
});
