import { publicOperations } from "@/lib/signal/operations/registry";

import { GENUI_PREVIEW_RESOURCE_URI } from "./genui-preview-resource";

const starterMcpAppResourceUri = GENUI_PREVIEW_RESOURCE_URI;

interface StarterMcpToolCard {
  description: string;
  name: string;
}

export const starterMcpToolCatalog: StarterMcpToolCard[] = [
  {
    description: "Liveness check for the MCP server.",
    name: "health",
  },
  {
    description: "List registered GenUI root components.",
    name: "list_component_catalog",
  },
  {
    description: "Generate a validated OpenUI composition from a natural-language UI request.",
    name: "compose_ui",
  },
  // Signal's public operations (`lib/signal/operations/registry.ts`); never Operator ones.
  ...publicOperations.map(({ description, name }) => ({ description, name })),
];

export const buildMcpServerCard = (origin: string) => ({
  authentication: { required: false },
  description:
    "Signal — search product needs, check for duplicates, and add your voice over MCP; plus GenUI compose tools.",
  resources: [
    {
      description: "GenUI Preview MCP App",
      mimeType: "text/html;profile=mcp-app",
      uri: starterMcpAppResourceUri,
    },
  ],
  serverInfo: {
    name: "signal",
    title: "Signal MCP",
    version: "1.0.0",
  },
  tools: starterMcpToolCatalog,
  transport: {
    endpoint: `${origin}/api/mcp`,
    type: "streamable-http",
  },
  version: "1.0",
});

export const buildMcpRegistryManifest = (origin: string) => ({
  mcpServers: {
    signal: {
      transport: {
        type: "http",
        url: `${origin}/api/mcp`,
      },
    },
  },
  serverCard: `${origin}/.well-known/mcp/server-card.json`,
});

export const buildAiCatalog = (origin: string) => ({
  servers: [
    {
      description: "Signal MCP — public need search and submission tools, plus GenUI compose.",
      name: "signal",
      transport: {
        type: "streamable-http",
        url: `${origin}/api/mcp`,
      },
      url: `${origin}/.well-known/mcp/server-card.json`,
    },
  ],
  version: "1.0",
});
