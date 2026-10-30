import { describe, expect, it, vi } from "vitest";

import { createSignalClient, signalRoutes } from "../lib/signal/client";
import { buildSignalRequest, callSignalOperation } from "../lib/signal/client-runtime";
import { allOperations } from "../lib/signal/operations/registry";

/** Spec 001 → Typed API contract: the UI's client is generated from the operation registry. */

const camelCase = (name: string) =>
  name.replaceAll(/_(?<letter>\w)/gu, (_, letter: string) => letter.toUpperCase());

describe("generated Signal client", () => {
  it("has one route per registry operation, with the registry's method, path, and access (run `pnpm signal:client` when this fails)", () => {
    const fromRegistry = Object.fromEntries(
      allOperations.map(({ access, http, name }) => [
        name,
        { access, method: http.method, name, path: http.path },
      ]),
    );
    expect(signalRoutes).toEqual(fromRegistry);
  });

  it("exposes a method per operation", () => {
    const client = createSignalClient();
    for (const { name } of allOperations)
      expect(typeof client[camelCase(name) as keyof typeof client]).toBe("function");
  });
});

describe("buildSignalRequest", () => {
  it("puts path params in the path and the rest in the query for GET", () => {
    const { init, url } = buildSignalRequest(
      signalRoutes.search_needs,
      { q: "pdf export", status: "open", theme: undefined },
      { baseUrl: "https://signal.example/" },
    );
    expect(url).toBe("https://signal.example/api/needs?q=pdf+export&status=open");
    expect(init.method).toBe("GET");

    expect(buildSignalRequest(signalRoutes.get_my_signals, { token: "a/b" }).url).toBe(
      "/api/my-signals/a%2Fb",
    );
  });

  it("sends a JSON body without path params for writes", () => {
    const { init, url } = buildSignalRequest(signalRoutes.resolve_suggestion, {
      action: "accept",
      id: "abc",
    });
    expect(url).toBe("/api/operator/suggestions/abc/resolve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "accept" });
  });

  it("rejects a missing path param", () => {
    expect(() => buildSignalRequest(signalRoutes.get_need, {})).toThrow(/id/u);
  });
});

const respond = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));

describe("callSignalOperation", () => {
  it("returns data on success", async () => {
    const fetch = respond({ needs: [], nextCursor: null });
    const result = await createSignalClient({ fetch }).searchNeeds({ q: "pdf" });
    expect(result).toEqual({ data: { needs: [], nextCursor: null }, ok: true });
    expect(fetch).toHaveBeenCalledWith("/api/needs?q=pdf", expect.anything());
  });

  it("returns the error envelope with the HTTP status", async () => {
    const fetch = respond(
      { error: { code: "database_unavailable", message: "Down.", retryable: true } },
      503,
    );
    const result = await createSignalClient({ fetch }).getNeed({
      id: "00000000-0000-4000-8000-000000000000",
    });
    expect(result).toEqual({
      error: { code: "database_unavailable", message: "Down.", retryable: true, status: 503 },
      ok: false,
    });
  });

  it("maps a response without an envelope and a network failure", async () => {
    const notJson = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("nope", { status: 502 })),
    );
    expect(
      await callSignalOperation(signalRoutes.search_needs, {}, { fetch: notJson }),
    ).toMatchObject({ error: { code: "unexpected_response", retryable: true, status: 502 } });

    const offline = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    expect(
      await callSignalOperation(signalRoutes.search_needs, {}, { fetch: offline }),
    ).toMatchObject({ error: { code: "network_error", retryable: true }, ok: false });
  });
});
