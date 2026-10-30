const SLUG = /^[a-z][a-z0-9-]{0,50}$/u;
const NEON = "https://console.neon.tech/api/v2";
const VERCEL = "https://api.vercel.com";

const requestJson = async ({ fetchImpl, url, token, method = "GET", body }) => {
  const response = await fetchImpl(url, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    method,
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { body: await response.json(), ok: true };
};

const withTeam = ({ path, teamId }) => {
  const url = new URL(`${VERCEL}${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  return url;
};

export const readDatabaseUrl = (text) => {
  const line = String(text ?? "")
    .split("\n")
    .find((entry) => entry.startsWith("DATABASE_URL="));
  const value = line?.slice("DATABASE_URL=".length).trim();
  return value || undefined;
};

export const upsertEnvLine = ({ text, key, value }) => {
  const lines = String(text ?? "").split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index === -1) {
    const base = text === "" || String(text).endsWith("\n") ? String(text ?? "") : `${text}\n`;
    return { changed: true, text: `${base}${key}=${value}\n` };
  }
  if (lines[index].slice(key.length + 1).trim()) return { changed: false, text: String(text) };
  lines[index] = `${key}=${value}`;
  return { changed: true, text: `${lines.join("\n").replace(/\n*$/u, "")}\n` };
};

const findOrCreateVercel = async ({ fetchImpl, token, teamId, projectName, rootDirectory }) => {
  const existing = await requestJson({
    fetchImpl,
    token,
    url: withTeam({ path: `/v9/projects/${projectName}`, teamId }),
  });
  if (existing.ok)
    return {
      created: false,
      ok: true,
      orgId: existing.body.accountId,
      projectId: existing.body.id,
    };
  if (existing.status !== 404)
    return { error: `Vercel project lookup failed (${existing.status})`, ok: false };
  const created = await requestJson({
    body: { framework: "nextjs", name: projectName, ...(rootDirectory ? { rootDirectory } : {}) },
    fetchImpl,
    method: "POST",
    token,
    url: withTeam({ path: "/v10/projects", teamId }),
  });
  if (!created.ok) return { error: `Vercel project create failed (${created.status})`, ok: false };
  return { created: true, ok: true, orgId: created.body.accountId, projectId: created.body.id };
};

const ensureVercelEnv = async ({ fetchImpl, token, teamId, projectId, databaseUrl }) => {
  const listed = await requestJson({
    fetchImpl,
    token,
    url: withTeam({ path: `/v9/projects/${projectId}/env`, teamId }),
  });
  if (!listed.ok) return { error: `Vercel env lookup failed (${listed.status})`, ok: false };
  if (listed.body.envs?.some((entry) => entry.key === "DATABASE_URL"))
    return { changed: false, ok: true };
  const written = await requestJson({
    body: {
      key: "DATABASE_URL",
      target: ["production", "preview", "development"],
      type: "encrypted",
      value: databaseUrl,
    },
    fetchImpl,
    method: "POST",
    token,
    url: withTeam({ path: `/v10/projects/${projectId}/env`, teamId }),
  });
  if (!written.ok) return { error: `Vercel env write failed (${written.status})`, ok: false };
  return { changed: true, ok: true };
};

const findOrCreateDatabase = async ({ fetchImpl, token, orgId, projectName }) => {
  const listed = await requestJson({
    fetchImpl,
    token,
    url: `${NEON}/projects?limit=100`,
  });
  if (!listed.ok) return { error: `Neon project lookup failed (${listed.status})`, ok: false };
  const existing = listed.body.projects?.find((project) => project.name === projectName);
  if (existing) {
    const uri = new URL(`${NEON}/projects/${existing.id}/connection_uri`);
    uri.searchParams.set("database_name", "neondb");
    uri.searchParams.set("role_name", "neondb_owner");
    uri.searchParams.set("pooled", "true");
    const connection = await requestJson({ fetchImpl, token, url: uri });
    if (!connection.ok || !connection.body.uri)
      return {
        error: `Neon connection lookup failed (${connection.status ?? "empty"})`,
        ok: false,
      };
    return { created: false, databaseUrl: connection.body.uri, ok: true };
  }
  const created = await requestJson({
    body: { project: { name: projectName, pg_version: 17, ...(orgId ? { org_id: orgId } : {}) } },
    fetchImpl,
    method: "POST",
    token,
    url: `${NEON}/projects`,
  });
  const databaseUrl = created.ok ? created.body.connection_uris?.[0]?.connection_uri : undefined;
  if (!created.ok || !databaseUrl)
    return {
      error: `Neon project create failed (${created.ok ? "empty" : created.status})`,
      ok: false,
    };
  return { created: true, databaseUrl, ok: true };
};

const provisionNeon = async ({ env, fetchImpl, local, projectName, rootDirectory }) => {
  const needDatabase = !local.databaseUrl;
  const needLink = !local.vercelProjectId;
  if ((needDatabase && !env.NEON_API_KEY) || (needLink && !env.VERCEL_TOKEN))
    return {
      error:
        "neon preset needs Neon and Vercel authorization before it creates a project or database",
      ok: false,
    };

  const link = needLink
    ? await findOrCreateVercel({
        fetchImpl,
        projectName,
        rootDirectory,
        teamId: env.VERCEL_TEAM_ID,
        token: env.VERCEL_TOKEN,
      })
    : { created: false, ok: true, orgId: local.vercelOrgId, projectId: local.vercelProjectId };
  if (!link.ok) return link;
  if (!env.VERCEL_TOKEN)
    return {
      error: "neon preset needs Vercel authorization before it writes environment",
      ok: false,
    };

  const database = needDatabase
    ? await findOrCreateDatabase({
        fetchImpl,
        orgId: env.NEON_ORG_ID,
        projectName,
        token: env.NEON_API_KEY,
      })
    : { created: false, databaseUrl: local.databaseUrl, ok: true };
  if (!database.ok) return database;

  const remoteEnv = await ensureVercelEnv({
    databaseUrl: database.databaseUrl,
    fetchImpl,
    projectId: link.projectId,
    teamId: env.VERCEL_TEAM_ID,
    token: env.VERCEL_TOKEN,
  });
  if (!remoteEnv.ok) return remoteEnv;
  return {
    changed: Boolean(link.created || database.created || remoteEnv.changed || needDatabase),
    databaseUrl: needDatabase ? database.databaseUrl : undefined,
    ok: true,
    preset: "neon",
    reused: !link.created && !database.created && !remoteEnv.changed,
    vercel: needLink ? { orgId: link.orgId, projectId: link.projectId } : undefined,
  };
};

export const applyDataPreset = ({
  env = {},
  fetchImpl = fetch,
  local = {},
  preset = "minimal",
  projectName,
  rootDirectory,
}) => {
  if (preset !== "neon") return { changed: false, ok: true, preset: "minimal" };
  if (!SLUG.test(projectName ?? "")) return { error: "project name must be a slug", ok: false };
  if (local.databaseUrl && local.vercelProjectId)
    return { changed: false, ok: true, preset: "neon", reused: true };
  return provisionNeon({ env, fetchImpl, local, projectName, rootDirectory });
};
