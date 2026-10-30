import { setCriteria } from "../../../lib/signal/operations/set-criteria";
import { insertCriteria } from "../support/builders";
import { runParityTable } from "./harness";

const valid = { business_value: 0.25, demand: 0.25, effort: 0.2, strategic_fit: 0.3 };

runParityTable({
  cases: [
    {
      expect: () => ({
        output: {
          criteria: [
            { description: "Supporters, weighted by account.", key: "demand", weight: 0.25 },
            {
              description: "Revenue of requesting accounts and open deals.",
              key: "business_value",
              weight: 0.25,
            },
            { description: "Match to PM-set themes.", key: "strategic_fit", weight: 0.3 },
            { description: "Rough effort estimate (5 = small).", key: "effort", weight: 0.2 },
          ],
        },
      }),
      input: () => ({ weights: valid }),
      name: "replaces the weights and returns the criteria",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ weights: { business_value: 0.5, demand: 0.5, strategic_fit: 0 } }),
      name: "rejects a missing key",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ weights: { ...valid, demand: 0.3 } }),
      name: "rejects weights that do not sum to 1",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({
        weights: { business_value: -0.2, demand: 1.2, effort: 0, strategic_fit: 0 },
      }),
      name: "rejects a weight outside 0–1",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ weights: { ...valid, effort: 0.1, urgency: 0.1 } }),
      name: "rejects an unknown key",
    },
  ],
  fixture: async (db) => {
    await insertCriteria(db);
  },
  mutates: true,
  operation: setCriteria,
});
