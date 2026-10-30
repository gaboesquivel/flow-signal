import { listThemes } from "../../../lib/signal/operations/list-themes";
import { insertTheme } from "../support/builders";
import { runParityTable } from "./harness";

runParityTable({
  cases: [
    {
      expect: (f: { reporting: { id: string }; integrations: { id: string } }) => ({
        output: {
          themes: [
            {
              description: "",
              id: f.integrations.id,
              name: "Integrations",
              strategicWeight: 0.5,
            },
            {
              description: "Dashboards and exports",
              id: f.reporting.id,
              name: "Reporting",
              strategicWeight: 0.75,
            },
          ],
        },
      }),
      input: () => ({}),
      name: "lists every theme by name, including themes with no need",
    },
  ],
  fixture: async (db) => {
    const reporting = await insertTheme(db, {
      description: "Dashboards and exports",
      name: "Reporting",
      strategicWeight: 0.75,
    });
    const integrations = await insertTheme(db, { name: "Integrations" });
    return { integrations, reporting };
  },
  operation: listThemes,
});
