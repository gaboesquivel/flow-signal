export const ESSENTIAL_CHECK_IDS = ['setup', 'qa', 'identity_scan', 'gitignore_artifacts']

export const normalizeCheckResults = (results) =>
  (results ?? []).map((entry) => ({
    id: entry.id,
    status: entry.status,
    detail: entry.detail ?? '',
  }))

export const canCreateInitialCommit = ({ checkResults }) => {
  const results = normalizeCheckResults(checkResults)
  const byId = new Map(results.map((r) => [r.id, r]))

  const missing = ESSENTIAL_CHECK_IDS.filter((id) => !byId.has(id))
  if (missing.length)
    return { ok: false, reason: `Essential checks not recorded: ${missing.join(', ')}` }

  const failed = results.filter((r) => r.status === 'failed')
  if (failed.length)
    return { ok: false, reason: `Failed checks block initial commit: ${failed.map((r) => r.id).join(', ')}` }

  return { ok: true }
}

export const formatInitialCommitMessage = ({ slug }) => `chore: initialize ${slug}`
