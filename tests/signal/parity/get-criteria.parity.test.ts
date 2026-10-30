import { getCriteria } from "../../../lib/signal/operations/get-criteria";
import { insertCriteria } from "../support/builders";
import { runParityTable } from "./harness";

runParityTable({
  cases: [
    {
      expect: () => ({
        output: {
          criteria: [
            { description: "Supporters, weighted by account.", key: "demand", weight: 0.4 },
            {
              description: "Revenue of requesting accounts and open deals.",
              key: "business_value",
              weight: 0.3,
            },
            { description: "Match to PM-set themes.", key: "strategic_fit", weight: 0.2 },
            { description: "Rough effort estimate (5 = small).", key: "effort", weight: 0.1 },
          ],
        },
      }),
      input: () => ({}),
      name: "returns every criterion with its weight and description, in a fixed order",
    },
  ],
  fixture: async (db) => {
    await insertCriteria(db);
  },
  operation: getCriteria,
});
