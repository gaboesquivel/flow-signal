#!/usr/bin/env node
// Merge gate: is this pull request's head ready to land? Only checks that actually ran and passed on that head count.
//   node required-checks.mjs <owner/repo> <number>
// Prints JSON. Exit 0 only when ready; 1 when not ready; 2 when GitHub could not be read (not ready either: fail closed).
// Reads through `gh api` REST, which works behind proxies that refuse GraphQL. Zero dependencies, Node >= 22.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export class ReadError extends Error {}

const PAGE = 100

const read = (api, path) => {
  try { return api(path) } catch (e) { throw new ReadError(`cannot read ${path}: ${e.message}`) }
}

// One page of a counted REST list; fail closed rather than judge on a partial list.
const all = (api, path, key) => {
  const body = read(api, `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}`)
  const items = body[key] ?? []
  if ((body.total_count ?? items.length) > items.length) throw new ReadError(`more than ${items.length} entries at ${path}`)
  return items
}

// A check run's or workflow run's state: success only when completed with conclusion success.
const runState = (r) => (r.status !== 'completed' ? 'pending' : r.conclusion ?? 'pending')
// The latest result among runs for one check or workflow: highest id, except that a skipped run never hides a real one.
// A draft event and the ready event can fire together, and the skipped draft run may get the higher id.
const latest = (list) => {
  const newest = [...list].sort((a, b) => b.id - a.id)
  return newest.find((r) => !(r.status === 'completed' && r.conclusion === 'skipped')) ?? newest[0]
}
// A commit status's state, in check-run terms.
const statusState = (s) => (s.state === 'error' ? 'failure' : s.state)

export function evaluate({ api, repo, number }) {
  const pr = read(api, `repos/${repo}/pulls/${number}`)
  const head = pr.head.sha
  const branch = encodeURIComponent(pr.base.ref)
  const reasons = []

  // Required checks from active rulesets and classic protection; both endpoints need only read access.
  const rules = read(api, `repos/${repo}/rules/branches/${branch}`)
  const fromRules = rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters.required_status_checks)
  const classic = read(api, `repos/${repo}/branches/${branch}`).protection?.required_status_checks ?? {}
  const fromClassic = [...(classic.checks ?? []), ...(classic.contexts ?? []).map((context) => ({ context }))]

  const runs = all(api, `repos/${repo}/commits/${head}/check-runs?filter=all`, 'check_runs').filter((r) => r.head_sha === head)
  const statuses = read(api, `repos/${repo}/commits/${head}/statuses?per_page=${PAGE}`)
  // Latest result for a context on this head, from the app the rule names when it names one: highest check-run id, else newest status.
  const resultFor = ({ context, integration_id: app }) => {
    const run = latest(runs.filter((r) => r.name === context && (app == null || r.app?.id === app)))
    if (run) return runState(run)
    const status = statuses.find((s) => s.context === context)
    return status ? statusState(status) : 'missing'
  }

  const byContext = new Map()
  for (const c of [...fromRules, ...fromClassic]) if (!byContext.has(c.context) || c.integration_id != null) byContext.set(c.context, c)
  let checks = [...byContext.values()].map((c) => ({ context: c.context, state: resultFor(c) }))
  const source = [fromRules.length && 'rulesets', fromClassic.length && 'protection'].filter(Boolean).join('+') || 'none'

  if (source === 'none') {
    // Without protection, judge each workflow by its latest run on the head (a skipped or failed-to-start run never passes,
    // and a skipped matrix job's renamed check cannot hide it), plus every check from other apps and every status.
    reasons.push(`no active protection on ${pr.base.ref}: every workflow and check on the head is treated as required`)
    const byWorkflow = Map.groupBy(all(api, `repos/${repo}/actions/runs?head_sha=${head}`, 'workflow_runs'), (w) => w.path ?? w.name)
    checks = [...byWorkflow.values()].map((list) => latest(list)).map((w) => ({ context: `workflow ${w.name}`, state: runState(w) }))
    const others = [...new Set(runs.filter((r) => r.app?.slug !== 'github-actions').map((r) => r.name))]
    checks.push(...others.map((context) => ({ context, state: resultFor({ context }) })))
    checks.push(...[...new Set(statuses.map((s) => s.context))].map((context) => ({ context, state: resultFor({ context }) })))
    if (!checks.length) reasons.push('no workflow or check reported on the head')
  }

  if (pr.state !== 'open') reasons.push(`pull request #${number} is ${pr.state}`)
  if (pr.draft) reasons.push(`pull request #${number} is a draft; mark it ready so its checks run`)
  for (const c of checks) if (c.state !== 'success') reasons.push(`${c.context} is ${c.state} on ${head.slice(0, 7)}`)

  const ready = pr.state === 'open' && !pr.draft && checks.length > 0 && checks.every((c) => c.state === 'success')
  return { ready, number, head, draft: Boolean(pr.draft), source, checks, reasons }
}

function main(argv) {
  const [repo, raw] = argv
  const number = Number(String(raw ?? '').replace('#', ''))
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repo ?? '') || !Number.isInteger(number) || number < 1) {
    console.log(JSON.stringify({ ready: false, reasons: ['usage: required-checks.mjs <owner/repo> <number>'] }))
    return 2
  }
  const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }))
  try {
    const result = evaluate({ api, repo, number })
    console.log(JSON.stringify(result, null, 2))
    return result.ready ? 0 : 1
  } catch (e) {
    console.log(JSON.stringify({ ready: false, reasons: [e.message] }))
    return 2
  }
}

const real = (path) => { try { return realpathSync(path) } catch { return path } }
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2))
