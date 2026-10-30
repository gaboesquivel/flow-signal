import { defineAgent } from "eve";

import { eveModelId } from "@/lib/ai/models";

export default defineAgent({
  model: eveModelId(),
  modelContextWindowTokens: 200_000,
});
