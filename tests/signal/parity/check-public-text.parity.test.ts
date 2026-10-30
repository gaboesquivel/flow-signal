import { checkPublicText } from "../../../lib/signal/operations/check-public-text";
import { buildPrioritizationFixture } from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";
import { runParityTable } from "./harness";

runParityTable<PrioritizationFixture>({
  cases: [
    {
      expect: () => ({
        output: {
          findings: [
            { kind: "account", match: "Acme" },
            { kind: "email", match: "maya@acme.example" },
          ],
        },
      }),
      input: () => ({ text: "Planned for Acme in Q1; questions to maya@acme.example." }),
      name: "flags workspace accounts and emails",
    },
    {
      expect: () => ({ output: { findings: [{ kind: "person", match: "Maya Lindqvist" }] } }),
      input: (fx) => ({ needId: fx.n1.need.id, text: "Thanks, Maya Lindqvist and Globexx." }),
      name: "flags a person when a need is given",
    },
    {
      expect: () => ({ output: { findings: [{ kind: "person", match: "Maya Lindqvist" }] } }),
      input: (fx) => ({ needId: fx.n3.need.id, text: "Thanks, Maya Lindqvist." }),
      name: "flags other customers too, not only the need's supporters",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ needId: "00000000-0000-4000-8000-000000000000", text: "Hello" }),
      name: "returns not_found for an unknown need",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ text: "x".repeat(10_001) }),
      name: "rejects text over 10,000 characters",
    },
  ],
  fixture: buildPrioritizationFixture,
  operation: checkPublicText,
});
