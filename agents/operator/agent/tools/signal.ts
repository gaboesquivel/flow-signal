import { defineDynamic } from "eve/tools";

import { signalAgentTools } from "@/lib/signal/adapters/agent";

/** Signal operations as tools (all of them), generated from the operation registry. */
export default defineDynamic({
  events: {
    "session.started": () => signalAgentTools("operator"),
  },
});
