import { describe, expect, it } from "vitest";

import { demandBand, toPublicStatus } from "../../../lib/signal/domain/public-needs";

describe("demandBand", () => {
  it("uses the weighted priority score when the need is scored", () => {
    expect(demandBand({ priorityScore: 4.2, supporterCount: 1 })).toBe("high");
    expect(demandBand({ priorityScore: 3.5, supporterCount: 1 })).toBe("high");
    expect(demandBand({ priorityScore: 2, supporterCount: 50 })).toBe("medium");
    expect(demandBand({ priorityScore: 1.9, supporterCount: 50 })).toBe("low");
  });

  it("falls back to supporter count for unscored needs", () => {
    expect(demandBand({ priorityScore: null, supporterCount: 10 })).toBe("high");
    expect(demandBand({ priorityScore: null, supporterCount: 4 })).toBe("medium");
    expect(demandBand({ priorityScore: null, supporterCount: 3 })).toBe("low");
  });
});

describe("toPublicStatus", () => {
  it("shows drafts as new and keeps other statuses", () => {
    expect(toPublicStatus("draft")).toBe("new");
    expect(toPublicStatus("planned")).toBe("planned");
    expect(toPublicStatus("merged")).toBe("merged");
  });
});
