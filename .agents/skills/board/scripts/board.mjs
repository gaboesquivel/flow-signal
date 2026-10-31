#!/usr/bin/env node
// Flow progress board: read-only kanban of a repository's specs, derived from git.
// Zero dependencies, Node >= 22. Stages: Candidate, Specced, Ready, Building, Shipped.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const COLUMNS = [
  { id: 'candidate', title: 'Candidate' },
  { id: 'specced', title: 'Specced' },
  { id: 'ready', title: 'Ready' },
  { id: 'building', title: 'Building' },
  { id: 'shipped', title: 'Shipped' },
]

const SPEC_DIR = 'docs/specs'
const SPEC_FILE = /^(\d{3})-(.+)\.md$/u

function git(repoRoot, args, input) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

function tryGit(repoRoot, args) {
  try { return git(repoRoot, args).trim() } catch { return null }
}

const refExists = (repoRoot, ref) => Boolean(tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))

/**
 * Resolves the default branch: local `main`, `origin/HEAD`'s target, local `master`, then `init.defaultBranch`.
 * Returns `{ name, ref }` with a full refname, or null when none exists.
 */
export function resolveDefaultBranch(repoRoot) {
  if (refExists(repoRoot, 'refs/heads/main')) return { name: 'main', ref: 'refs/heads/main' }
  const originHead = tryGit(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (originHead && refExists(repoRoot, originHead)) return { name: originHead.replace(/^refs\/remotes\//u, ''), ref: originHead }
  if (refExists(repoRoot, 'refs/heads/master')) return { name: 'master', ref: 'refs/heads/master' }
  const configured = tryGit(repoRoot, ['config', '--get', 'init.defaultBranch'])
  if (configured && refExists(repoRoot, `refs/heads/${configured}`)) return { name: configured, ref: `refs/heads/${configured}` }
  return null
}

function listSpecFiles(repoRoot, ref) {
  const out = tryGit(repoRoot, ['ls-tree', '-z', '--name-only', `${ref}:${SPEC_DIR}`])
  if (!out) return []
  return out.split('\0').filter((name) => SPEC_FILE.test(name))
}

/** Reads many `ref:path` blobs with one `git cat-file --batch` pass. */
function readBlobs(repoRoot, objects) {
  if (!objects.length) return []
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd: repoRoot, input: `${objects.join('\n')}\n`, maxBuffer: 64 * 1024 * 1024 })
  const contents = []
  let offset = 0
  for (let i = 0; i < objects.length; i++) {
    const newline = out.indexOf(10, offset)
    const header = out.subarray(offset, newline).toString('utf8')
    offset = newline + 1
    const size = Number(/ blob (\d+)$/u.exec(header)?.[1])
    if (!Number.isFinite(size)) { contents.push(''); continue }
    contents.push(out.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  return contents
}

// Results keyed by (repo, default tip, branch tip) so a polling caller re-runs only what changed.
const mergeCache = new Map()

function cached(key, compute) {
  if (mergeCache.size > 10000) mergeCache.clear() // a long-running server sees many default tips
  if (!mergeCache.has(key)) mergeCache.set(key, compute())
  return mergeCache.get(key)
}

/**
 * A branch counts as merged when its tip is not on the default branch's first-parent history (so empty
 * branches cut from the default branch never count) and either it is an ancestor of the default branch or
 * merging it would leave the default branch's tree unchanged (squash merges).
 */
function isMerged(repoRoot, { ref, sha }, { defaultRef, defaultSha, defaultTree, firstParent, ancestors }) {
  if (firstParent.has(sha)) return false
  if (ancestors.has(ref)) return true
  return cached(`merged ${repoRoot} ${defaultSha} ${sha}`, () => {
    const tree = tryGit(repoRoot, ['merge-tree', '--write-tree', defaultRef, sha])
    return Boolean(tree) && tree.split('\n')[0] === defaultTree
  })
}

/**
 * Whether a merged branch carried implementation work: its own changes touch a path outside `docs/`.
 * The branch's own changes are measured from where it forked: for a branch merged by a merge commit, the
 * merge-base with that merge commit's first parent; otherwise the merge-base with the default branch.
 */
function hasImplementationWork(repoRoot, { sha }, { defaultRef, defaultSha, firstParent }) {
  return cached(`impl ${repoRoot} ${defaultSha} ${sha}`, () => {
    let base = null
    const descendants = (tryGit(repoRoot, ['rev-list', '--ancestry-path', `${sha}..${defaultRef}`]) ?? '').split('\n').filter((c) => firstParent.has(c))
    const mergeCommit = descendants.at(-1)
    if (mergeCommit) base = tryGit(repoRoot, ['merge-base', `${mergeCommit}^1`, sha])
    base ??= tryGit(repoRoot, ['merge-base', defaultRef, sha])
    if (!base) return false
    const out = tryGit(repoRoot, ['diff', '-z', '--name-only', base, sha]) ?? ''
    return out.split('\0').filter(Boolean).some((path) => !path.startsWith('docs/'))
  })
}

/**
 * Gathers raw facts from git. Specs come from the default branch; spec files that exist only on unmerged
 * branches are included once each (local before remote, then by name) with `onDefault: false`.
 * Merged branches that match a spec slug carry `implementation`: whether they changed anything outside `docs/`.
 */
export function readSnapshot(repoRoot, { github = null } = {}) {
  const defaultBranch = resolveDefaultBranch(repoRoot)
  if (!defaultBranch) {
    const hasCommits = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) || tryGit(repoRoot, ['for-each-ref', '--count=1', 'refs/heads', 'refs/remotes'])
    throw new Error(hasCommits
      ? 'No default branch found (tried main, origin/HEAD, master, init.defaultBranch).'
      : 'No commits yet: commit the specs first, then show the board.')
  }
  const defaultRef = defaultBranch.ref
  const context = {
    defaultRef,
    defaultSha: git(repoRoot, ['rev-parse', `${defaultRef}^{commit}`]).trim(),
    defaultTree: git(repoRoot, ['rev-parse', `${defaultRef}^{tree}`]).trim(),
    firstParent: new Set(git(repoRoot, ['rev-list', '--first-parent', defaultRef]).split('\n').filter(Boolean)),
    ancestors: new Set(git(repoRoot, ['for-each-ref', `--merged=${defaultRef}`, '--format=%(refname)', 'refs/heads', 'refs/remotes']).split('\n').filter(Boolean)),
  }
  const defaultShort = defaultRef.startsWith('refs/remotes/') ? defaultBranch.name.split('/').slice(1).join('/') : defaultBranch.name
  const branches = []
  for (const line of git(repoRoot, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes']).split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ')
    if (ref === defaultRef || ref.endsWith('/HEAD')) continue
    const remote = ref.startsWith('refs/remotes/')
    const name = ref.replace(/^refs\/(?:heads|remotes)\//u, '')
    if (remote && name.split('/').slice(1).join('/') === defaultShort) continue
    branches.push({ name, ref, sha, remote, merged: isMerged(repoRoot, { ref, sha }, context) })
  }
  branches.sort((a, b) => Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name))

  const sources = []
  const seen = new Set()
  for (const file of listSpecFiles(repoRoot, defaultRef)) {
    seen.add(file)
    sources.push({ file, ref: defaultRef, source: defaultBranch.name, onDefault: true, remote: defaultRef.startsWith('refs/remotes/') })
  }
  for (const branch of branches.filter((b) => !b.merged)) {
    for (const file of listSpecFiles(repoRoot, branch.ref)) {
      if (seen.has(file)) continue
      seen.add(file)
      sources.push({ file, ref: branch.ref, source: branch.name, onDefault: false, remote: branch.remote })
    }
  }
  const contents = readBlobs(repoRoot, sources.map((s) => `${s.ref}:${SPEC_DIR}/${s.file}`))
  const specs = sources.map(({ ref, ...rest }, i) => ({ ...rest, content: contents[i] }))

  // Only branches that some spec could claim need the (costlier) implementation check.
  const slugs = specs.map((spec) => SPEC_FILE.exec(spec.file)[2])
  const claimed = (name) => slugs.some((slug) => matchBranches(slug, [{ name }]).length)
  // An unset Delivery line is inferred: no remote means local; otherwise GitHub data is read when a GitHub remote exists.
  const delivery = readDelivery(readBlobs(repoRoot, ['AGENTS.md', 'CLAUDE.md'].map((file) => `${defaultRef}:${file}`)))
    ?? (tryGit(repoRoot, ['remote']) ? null : 'local')
  let githubData = null
  if (github && delivery !== 'local') {
    githubData = github(repoRoot) ?? null
    // Without a GitHub remote, enrichment is only worth a note when the project says it uses GitHub mode.
    if (githubData?.reason === 'no GitHub remote' && delivery !== 'github') githubData = null
  }
  // In every mode an open branch counts as Building only with implementation work.
  for (const branch of branches) {
    if (claimed(branch.name)) branch.implementation = hasImplementationWork(repoRoot, branch, context)
  }
  if (githubData?.available) {
    githubData = {
      ...githubData,
      prs: githubData.prs.map((pr) => (pr.state === 'MERGED' && pr.baseRefName === defaultShort && claimed(pr.headRefName ?? '')
        ? { ...pr, implementation: prHasImplementationWork(repoRoot, pr.mergeCommit?.oid) }
        : pr)),
    }
    const added = specAddedDates(repoRoot, defaultRef)
    for (const spec of specs) if (spec.onDefault && added.has(spec.file)) spec.addedAt = added.get(spec.file)
  }
  return { repoName: basename(repoRoot), defaultBranch: defaultBranch.name, delivery, branches, specs, github: githubData, generatedAt: new Date().toISOString() }
}

// Legacy Delivery values; same list as LEGACY_GITHUB in skills/flow/lib/flow-block.mjs.
const LEGACY_GITHUB = ['pull-request', 'pull-requests', 'pullrequest', 'pr']

/** Committer date of the latest commit on `ref` that added each spec file, from one `git log`. */
function specAddedDates(repoRoot, ref) {
  const out = tryGit(repoRoot, ['-c', 'core.quotePath=false', 'log', '--diff-filter=A', '--format=@@%cI', '--name-only', ref, '--', SPEC_DIR]) ?? ''
  const added = new Map()
  let date = null
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) date = line.slice(2)
    else if (line && date) {
      const file = line.slice(SPEC_DIR.length + 1)
      if (!added.has(file)) added.set(file, date)
    }
  }
  return added
}

/**
 * `Delivery:` from the first Flow block (between the BEGIN/END FLOW markers) in the given texts; null when unset.
 * Mirrors readDelivery and normalizeDelivery in skills/flow/lib/flow-block.mjs (copied: each skill installs on its own).
 */
export function readDelivery(texts) {
  for (const text of texts) {
    const block = /<!-- BEGIN FLOW -->([\s\S]*?)<!-- END FLOW -->/u.exec(text)?.[1]
    const value = block && /^Delivery:[ \t]*(.*)$/imu.exec(block)?.[1].trim().toLowerCase().replace(/[\s_]+/gu, '-')
    if (!value) continue
    if (value === 'github' || LEGACY_GITHUB.includes(value)) return 'github'
    return value === 'local' ? 'local' : null
  }
  return null
}

/**
 * Whether a merged pull request changed a path outside `docs/`, measured from its merge commit's first parent
 * (squash and merge commits; a rebase merge shows only its last commit). False when the merge commit is not
 * available locally: without it, git cannot confirm implementation work.
 */
function prHasImplementationWork(repoRoot, oid) {
  if (!oid || !/^[0-9a-f]{40}$/u.test(oid)) return false
  return cached(`pr ${repoRoot} ${oid}`, () => {
    if (!tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`])) return false
    const out = tryGit(repoRoot, ['diff', '-z', '--name-only', `${oid}^1`, oid]) ?? ''
    return out.split('\0').filter(Boolean).some((path) => !path.startsWith('docs/'))
  })
}

export const PR_LIMIT = 200
export const ISSUE_LIMIT = 500

/** Runs `gh` with an argument array and a timeout; returns stdout. Throws like execFileSync. For `--once`/`--json`. */
export function runGh(args, { cwd, timeout = 5000 } = {}) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

/** Async `gh`: resolves to stdout, rejects like execFile. Keeps the live server's request path free. */
export async function runGhAsync(args, { cwd, timeout = 5000 } = {}) {
  const { stdout } = await execFileAsync('gh', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/** `owner/name` when a remote URL points at github.com (https, ssh, scp-like); null otherwise. */
export function parseGithubRemote(url) {
  const match = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/\s]+@)?github\.com(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(String(url).trim())
  return match ? `${match[1]}/${match[2]}` : null
}

function ghFailure(error) {
  if (error?.code === 'ENOENT') return 'gh not installed'
  if (error?.code === 'ETIMEDOUT' || error?.killed || error?.signal === 'SIGTERM') return 'GitHub request timed out'
  const stderr = String(error?.stderr ?? '')
  if (/HTTP 403/u.test(stderr)) return 'GitHub refused the request (HTTP 403): the token or a proxy blocks this API'
  if (/auth login|not logged in|authenticat/iu.test(stderr)) return 'gh not authenticated'
  return 'gh request failed'
}

const PAGE = 100

/** Pull request from REST, in the field names and uppercase states the board reads. */
export function restPr(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? 'MERGED' : String(pr.state).toUpperCase(),
    headRefName: pr.head?.ref,
    baseRefName: pr.base?.ref,
    url: pr.html_url,
    mergedAt: pr.merged_at ?? null,
    mergeCommit: pr.merged_at && pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null,
    body: pr.body ?? '',
  }
}

/** Pages `gh api <path>&page=N` until `limit` kept items, a short page, or `maxPages`; `full` says more may exist. */
function* paged(path, limit, keep = () => true, maxPages = Math.ceil(limit / PAGE)) {
  const items = []
  for (let page = 1; ; page++) {
    const batch = JSON.parse(yield ['api', `${path}&per_page=${PAGE}&page=${page}`])
    if (!Array.isArray(batch)) throw new SyntaxError('not an array')
    items.push(...batch.filter(keep))
    if (batch.length < PAGE) return { items, full: false }
    if (items.length >= limit || page >= maxPages) return { items: items.slice(0, limit), full: true }
  }
}

/**
 * The fetch as a sequence of `gh` calls (REST only: cloud proxies refuse GraphQL): yields argument arrays, receives
 * stdout (or a thrown error), returns `{ available: true, prs, issues, truncated }` or `{ available: false, reason }`.
 * One sequence, two drivers: synchronous for `--once`/`--json`, asynchronous for the live server.
 */
function* githubSteps(repoRoot) {
  const remotes = (tryGit(repoRoot, ['remote']) ?? '').split('\n').filter(Boolean).sort((a, b) => Number(b === 'origin') - Number(a === 'origin'))
  if (!remotes.length) return { available: false, reason: 'no GitHub remote' }
  let repo = null
  for (const remote of remotes) repo ??= parseGithubRemote(tryGit(repoRoot, ['remote', 'get-url', remote]) ?? '')
  if (!repo) {
    // Host aliases (`github.com-work`) or other hosts: let gh resolve the remote through its {owner}/{repo} placeholders.
    let view
    try { view = JSON.parse(yield ['api', 'repos/{owner}/{repo}']) } catch { return { available: false, reason: 'no GitHub remote' } }
    const host = /^https?:\/\/([^/]+)\//u.exec(String(view?.html_url ?? ''))?.[1]?.toLowerCase()
    if (!view?.full_name || !host) return { available: false, reason: 'no GitHub remote' }
    if (host !== 'github.com') return { available: false, reason: `remote is on ${host}, links support github.com only` }
    repo = view.full_name
  }
  try {
    const prs = yield* paged(`repos/${repo}/pulls?state=all&sort=created&direction=desc`, PR_LIMIT)
    // The issues endpoint lists pull requests too, so it may read their pages as well.
    const issues = yield* paged(`repos/${repo}/issues?state=all&sort=created&direction=desc`, ISSUE_LIMIT, (issue) => !issue.pull_request, Math.ceil((ISSUE_LIMIT + PR_LIMIT) / PAGE))
    return {
      available: true,
      prs: prs.items.map(restPr),
      issues: issues.items.map((issue) => ({ number: issue.number, title: issue.title, state: String(issue.state).toUpperCase(), url: issue.html_url })),
      truncated: { prs: prs.full, issues: issues.full },
    }
  } catch (error) {
    return { available: false, reason: error instanceof SyntaxError ? 'unexpected gh output' : ghFailure(error) }
  }
}

/** Fetches with synchronous `gh` calls; never throws. `run(args, { cwd })` is injectable for tests. */
export function fetchGithub(repoRoot, { run = runGh } = {}) {
  const steps = githubSteps(repoRoot)
  let step = steps.next()
  while (!step.done) {
    let out
    try { out = run(step.value, { cwd: repoRoot }) } catch (error) { step = steps.throw(error); continue }
    step = steps.next(out)
  }
  return step.value
}

/** Same as fetchGithub with an async `run`; never rejects. */
export async function fetchGithubAsync(repoRoot, { run = runGhAsync } = {}) {
  const steps = githubSteps(repoRoot)
  let step = steps.next()
  while (!step.done) {
    let out
    try { out = await run(step.value, { cwd: repoRoot }) } catch (error) { step = steps.throw(error); continue }
    step = steps.next(out)
  }
  return step.value
}

/** A failed refresh keeps the last good data, marked stale, so stages do not flip on a flaky network. */
function keepLastGood(previous, next) {
  if (next.available || !previous?.available) return next
  return { ...previous, stale: next.reason }
}

/** Wraps fetchGithub with a cache: at most one synchronous fetch per `ttlMs` per repository. */
export function githubReader({ run = runGh, ttlMs = 0 } = {}) {
  const cache = new Map()
  return (repoRoot) => {
    const hit = cache.get(repoRoot)
    if (hit && Date.now() - hit.at < ttlMs) return hit.value
    const value = keepLastGood(hit?.value, fetchGithub(repoRoot, { run }))
    cache.set(repoRoot, { at: Date.now(), value })
    return value
  }
}

/**
 * Stale-while-revalidate source for the live server: returns the cached data at once (null before the first
 * fetch finishes) and starts a background refresh when it is older than `ttlMs`. Never waits on `gh`.
 * `source.refresh(repoRoot)` returns the in-flight refresh.
 */
export function githubSource({ run = runGhAsync, ttlMs = 60_000 } = {}) {
  const entries = new Map()
  const refresh = (repoRoot) => {
    let entry = entries.get(repoRoot)
    if (!entry) entries.set(repoRoot, (entry = { at: 0, value: null, pending: null }))
    entry.pending ??= fetchGithubAsync(repoRoot, { run })
      .catch((error) => ({ available: false, reason: ghFailure(error) }))
      .then((value) => { entry.value = keepLastGood(entry.value, value); entry.at = Date.now(); entry.pending = null })
    return entry.pending
  }
  const source = (repoRoot) => {
    const entry = entries.get(repoRoot)
    if (!entry || (!entry.pending && Date.now() - entry.at >= ttlMs)) refresh(repoRoot)
    return entries.get(repoRoot).value
  }
  source.refresh = refresh
  return source
}
/** Status word from the spec header (`Status: draft` or `**Status:** draft`), lowercased; null when absent. */
export function parseStatus(content) {
  const header = content.split(/^## /mu)[0]
  const match = /^\*{0,2}Status\*{0,2}:\*{0,2}\s*(.*)$/imu.exec(header)
  if (!match) return null
  return (/^[a-z]+/iu.exec(match[1].trim())?.[0] ?? '').toLowerCase() || null
}

export function parseTitle(content, fallback) {
  const match = /^#\s+(?:\d{3}:\s*)?(.+)$/mu.exec(content)
  return match ? match[1].trim() : fallback
}

/** The `## Tasks` section (or a `### Tasks` subsection) up to the next heading of the same or a higher level; null when absent. */
function tasksSection(content) {
  const match = /^## Tasks[^\n]*\n/mu.exec(content) ?? /^### Tasks[^\n]*\n/mu.exec(content)
  if (!match) return null
  const rest = content.slice(match.index + match[0].length)
  const level = match[0].indexOf(' ')
  const end = new RegExp(`^#{1,${level}} `, 'mu').exec(rest)
  return end ? rest.slice(0, end.index) : rest
}

/** Issue numbers in parenthesized groups that start with `#N`, as in `(#45)` or `(#85, blocked by 06)`. */
const parenRefs = (text) => [...text.matchAll(/\((#\d+[^()]*)\)/gu)].flatMap(([, group]) => [...group.matchAll(/(?<![\w&])#(\d+)\b/gu)].map(([, n]) => Number(n)))

/**
 * Tasks in the Tasks section, merged by number: checklist items `- [ ] NN: Title (#45)` above any task heading,
 * and `### NN: Title (#45)` headings. A heading is done when its `**Status:**` starts with "done" or it has
 * checkboxes and all are checked; a task is done when its checklist item is ticked or its heading is done.
 */
function readTasks(content) {
  const section = tasksSection(content)
  if (section === null) return []
  const firstHeading = section.search(/^### +\d+/mu)
  const list = firstHeading === -1 ? section : section.slice(0, firstHeading)
  const byId = new Map()
  const add = (task) => {
    const key = Number(task.id)
    const previous = byId.get(key)
    if (!previous) { byId.set(key, task); return }
    byId.set(key, { id: previous.id, title: task.title ?? previous.title, done: previous.done || task.done, refs: [...new Set([...previous.refs, ...task.refs])] })
  }
  for (const [, box, id, rest] of list.matchAll(/^[ \t]*[-*] \[([ xX])\][ \t]+(\d+)[ \t]*[:.)-][ \t]*([^\n]*)$/gmu)) {
    const title = rest.replace(/\s*\(#\d+[^()]*\)\s*\.?\s*$/u, '').trim()
    add({ id, title: title || null, done: box !== ' ', refs: parenRefs(rest) })
  }
  for (const [, id, rest, block] of section.matchAll(/^### +(\d+)([^\n]*)\n([\s\S]*?)(?=^### |(?![\s\S]))/gmu)) {
    const status = /^\*\*Status:?\*\*:?\s*(\S+)/imu.exec(block)?.[1]?.toLowerCase() ?? ''
    const boxes = [...block.matchAll(/^\s*[-*] \[([ xX])\]/gmu)]
    const title = rest.replace(/^\s*[:.)-]?\s*/u, '').replace(/\s*\((?:#\d+[\s,]*)+\)\s*$/u, '').trim()
    const refs = [...rest.matchAll(/(?<![\w&])#(\d+)\b/gu)].map(([, n]) => Number(n))
    add({ id, title: title || null, done: status.startsWith('done') || (boxes.length > 0 && boxes.every((b) => b[1] !== ' ')), refs })
  }
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

/**
 * Counts tasks in the Tasks section: numbered checklist items and `### NN:` headings (see readTasks).
 * Without either, each `- [ ]`/`- [x]` is one task.
 */
export function countTasks(content) {
  const tasks = readTasks(content)
  if (tasks.length) return { done: tasks.filter((task) => task.done).length, total: tasks.length }
  const boxes = [...(tasksSection(content) ?? '').matchAll(/^\s*[-*] \[([ xX])\]/gmu)]
  return { done: boxes.filter((box) => box[1] !== ' ').length, total: boxes.length }
}

/** Tasks from checklist items and `### NN:` headings: `{ id, title, done }`, with issue refs stripped from the title. */
export function parseTasks(content) {
  return readTasks(content).map(({ id, title, done }) => ({ id, title, done }))
}

/** Issue numbers referenced as `#N` on task checklist items and `### NN:` task headings, in order, unique. */
export function taskIssueRefs(content) {
  return [...new Set(readTasks(content).flatMap((task) => task.refs))]
}

/** Only http(s) github.com URLs become links; anything else is dropped. */
export const safeGithubUrl = (url) => (typeof url === 'string' && /^https?:\/\/github\.com\//u.test(url) ? url : null)

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/giu

/**
 * Pure: the card's task issues and its pull request (open before merged, then newest) among open or merged pull
 * requests whose head branch matches the slug or whose body closes one of the card's task issues.
 * `mergedPrs`: merged pull requests from a slug-matched head into the default branch, shaped like merged branches.
 * `closedUnmerged`: the slug's newest pull request was closed without merging and none is open or merged.
 */
function githubLinks(slug, refs, github, addedAt) {
  if (!github?.available) return { issues: [], pr: null, mergedPrs: [], closedUnmerged: false }
  const headMatches = (pr) => Boolean(pr.headRefName) && matchBranches(slug, [{ name: pr.headRefName }]).length > 0
  const byNumber = new Map(github.issues.map((issue) => [issue.number, issue]))
  const issues = refs.filter((n) => byNumber.has(n)).map((n) => {
    const issue = byNumber.get(n)
    return { number: n, state: String(issue.state ?? '').toLowerCase() || null, url: safeGithubUrl(issue.url) }
  })
  const own = new Set(issues.map((i) => i.number))
  const linked = github.prs.filter((pr) => (pr.state === 'OPEN' || pr.state === 'MERGED')
    && (headMatches(pr) || [...String(pr.body ?? '').matchAll(CLOSES)].some(([, n]) => own.has(Number(n)))))
  linked.sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number)
  const top = linked[0]
  const pr = top ? { number: top.number, state: String(top.state).toLowerCase(), url: safeGithubUrl(top.url) } : null
  const closedUnmerged = !top && github.prs.some((p) => p.state === 'CLOSED' && headMatches(p))
  // For staging, stricter than links: readSnapshot sets `implementation` only on merged pull requests into the
  // default branch; the head's last segment starts with the slug; the merge is not older than the spec file
  // (one minute of slack for a spec added by the same squash merge).
  const startsWithSlug = new RegExp(`^(?:\\d{3}-)?${escapeRegExp(slug)}(?:$|[-_])`, 'u')
  const added = Date.parse(addedAt ?? '')
  const afterSpec = (p) => Number.isNaN(added) || Number.isNaN(Date.parse(p.mergedAt ?? '')) || Date.parse(p.mergedAt) >= added - 60_000
  const mergedPrs = github.prs
    .filter((p) => p.state === 'MERGED' && typeof p.implementation === 'boolean' && startsWithSlug.test(String(p.headRefName ?? '').split('/').pop()) && afterSpec(p))
    .sort((a, b) => b.number - a.number)
    .map((p) => ({ name: p.headRefName, remote: false, merged: true, implementation: p.implementation, pr: p.number }))
  return { issues, pr, mergedPrs, closedUnmerged }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Branches whose last path segment contains the slug on token boundaries (`feat/board`, `feat/012-board`,
 * `feat/board-live`, not `feat/dashboard`). Unmerged before merged, local before remote, then by name.
 */
export function matchBranches(slug, branches) {
  const pattern = new RegExp(`(?:^|[-_])(?:\\d{3}-)?${escapeRegExp(slug)}(?:$|[-_])`, 'u')
  return branches
    .filter((branch) => pattern.test(branch.name.split('/').pop()))
    .sort((a, b) => Number(a.merged) - Number(b.merged) || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name))
}

function stageFor({ status, tasks, branches }) {
  const tasksComplete = tasks.total === 0 || tasks.done === tasks.total
  if (status === 'implemented') return { stage: 'shipped', reason: 'status implemented', branch: null }
  // A merge ships only implementation work (`implementation`: changes outside docs/), never a candidate.
  const merged = branches.find((b) => b.merged && b.implementation)
  if (merged && tasksComplete && status !== 'candidate') return { stage: 'shipped', reason: merged.pr ? `pull request #${merged.pr} merged` : `branch ${merged.name} merged`, branch: merged }
  // An open spec branch alone is not Building: it needs implementation work.
  const open = branches.find((b) => !b.merged && b.implementation)
  if (open) return { stage: 'building', reason: `branch ${open.name}`, branch: open }
  if (tasks.done > 0) return { stage: 'building', reason: 'tasks started', branch: null }
  if (tasks.total > 0) return { stage: 'ready', reason: 'tasks planned', branch: null }
  if (status === 'candidate') return { stage: 'candidate', reason: 'status candidate', branch: null }
  return { stage: 'specced', reason: status === 'draft' || status === 'accepted' ? `status ${status}` : 'status unknown', branch: null }
}

const sourceOrder = (a, b) => Number(b.onDefault ?? true) - Number(a.onDefault ?? true)
  || Number(a.remote ?? false) - Number(b.remote ?? false)
  || String(a.source ?? '').localeCompare(String(b.source ?? ''))
  || a.file.localeCompare(b.file)

export const STATUSES = ['candidate', 'draft', 'accepted', 'implemented', 'dropped']

/**
 * Pure: snapshot -> { columns: [{ id, title, cards }], dropped }. First matching stage rule wins.
 * One card per spec number: the default branch wins, then local before remote branches, then by name;
 * losing files are named in the winner's marker. Branch-only specs are capped at Building.
 * A spec with status `dropped`, or a branch-only spec whose pull request closed unmerged, leaves the columns
 * and is listed under `dropped`. GitHub data only adds links and merged pull requests; stages never need it.
 */
export function deriveBoard(snapshot) {
  const columns = COLUMNS.map((column) => ({ ...column, cards: [] }))
  const byId = new Map(columns.map((column) => [column.id, column]))
  const byNumber = new Map()
  for (const spec of [...snapshot.specs].sort(sourceOrder)) {
    const number = SPEC_FILE.exec(spec.file)?.[1]
    if (!number) continue
    if (!byNumber.has(number)) byNumber.set(number, { spec, collisions: [] })
    else byNumber.get(number).collisions.push(spec)
  }
  const dropped = []
  for (const [number, { spec, collisions }] of [...byNumber].sort(([a], [b]) => a.localeCompare(b))) {
    const slug = SPEC_FILE.exec(spec.file)[2]
    const onDefault = spec.onDefault ?? true
    const status = parseStatus(spec.content)
    const tasks = countTasks(spec.content)
    const links = githubLinks(slug, taskIssueRefs(spec.content), snapshot.github, spec.addedAt)
    // Merged git branches come first; a merged pull request adds what git cannot see (a squash merge later edited).
    const matched = matchBranches(slug, snapshot.branches ?? [])
    const branches = [...matched.filter((b) => b.merged), ...links.mergedPrs, ...matched.filter((b) => !b.merged)]
    let { stage, reason, branch } = stageFor({ status, tasks, branches })
    if (!onDefault && stage === 'shipped') {
      stage = 'building'
      reason = `on branch ${spec.source}`
      branch = { name: spec.source }
    }
    const markers = []
    if (!status) markers.push('no status line')
    else if (!STATUSES.includes(status)) markers.push(`unknown status "${status}"`)
    if (!onDefault) markers.push(`on branch ${spec.source}`)
    const open = tasks.total - tasks.done
    if (stage === 'shipped' && status === 'implemented' && open > 0) markers.push(`status implemented, ${open} task${open === 1 ? '' : 's'} open`)
    for (const other of collisions) markers.push(`number ${number} also used by ${other.file}${other.onDefault === false ? ` on ${other.source}` : ''}`)
    const card = {
      number,
      slug,
      title: parseTitle(spec.content, slug),
      status,
      tasks,
      branch: branch?.name ?? null,
      source: spec.source ?? null,
      reason,
      marker: markers.length ? markers.join('; ') : null,
      issues: links.issues,
      pr: links.pr,
    }
    if (status === 'dropped') dropped.push({ ...card, dropped: true, reason: 'status dropped' })
    else if (!onDefault && links.closedUnmerged) dropped.push({ ...card, dropped: true, reason: 'pull request closed unmerged' })
    else byId.get(stage).cards.push(card)
  }
  const github = snapshot.github ?? null
  const notes = []
  if (github && !github.available) notes.push(`GitHub links unavailable: ${github.reason ?? 'unknown reason'}`)
  if (github?.available && github.stale) notes.push(`GitHub links may be out of date: ${github.stale}`)
  if (github?.available && github.truncated?.prs) notes.push(`GitHub links may be incomplete: read only the latest ${PR_LIMIT} pull requests`)
  if (github?.available && github.truncated?.issues) notes.push(`GitHub links may be incomplete: read only the latest ${ISSUE_LIMIT} issues`)
  const githubNote = notes.length ? notes.join('; ') : null
  return { repoName: snapshot.repoName ?? null, defaultBranch: snapshot.defaultBranch ?? null, generatedAt: snapshot.generatedAt ?? null, githubNote, columns, dropped }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function renderCard(card) {
  const meta = []
  if (card.tasks.total) meta.push(`<span class="progress">${card.tasks.done}/${card.tasks.total}</span>`)
  if (card.branch) meta.push(`<span class="branch">${escapeHtml(card.branch)}</span>`)
  const marker = card.marker ? `<p class="marker">${escapeHtml(card.marker)}</p>` : ''
  const links = [
    ...(card.pr ? [{ text: `PR #${card.pr.number}`, ...card.pr }] : []),
    ...(card.issues ?? []).map((issue) => ({ text: `#${issue.number}`, ...issue })),
  ].map(({ text, state, url }) => {
    const label = escapeHtml(state ? `${text} ${state}` : text)
    const href = safeGithubUrl(url)
    return href ? `<a class="gh" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>` : `<span class="gh">${label}</span>`
  })
  return `<li class="card" data-spec="${escapeHtml(card.number)}"><p class="num">${escapeHtml(card.number)}</p><h3>${escapeHtml(card.title)}</h3>${meta.length ? `<p class="meta">${meta.join('')}</p>` : ''}${links.length ? `<p class="links">${links.join('')}</p>` : ''}${marker}</li>`
}

const subline = (board) => [board.defaultBranch && `from ${board.defaultBranch}`, board.generatedAt && `generated ${board.generatedAt}`].filter(Boolean).join(' · ')
const headerNote = (board) => board.githubNote ?? ''

/**
 * Live page client: polls ./state and rebuilds the columns with the same markup as renderCard, through
 * textContent only. No board data is inlined into the script. Exported for the markup drift test.
 */
export const LIVE_SCRIPT = `(() => {
const main = document.querySelector('main'), sub = document.querySelector('header .sub'), note = document.querySelector('header .note'), banner = document.getElementById('banner')
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const card = (c) => {
  const li = el('li', 'card'); li.dataset.spec = c.number
  li.append(el('p', 'num', c.number), el('h3', null, c.title))
  const meta = []
  if (c.tasks.total) meta.push(el('span', 'progress', c.tasks.done + '/' + c.tasks.total))
  if (c.branch) meta.push(el('span', 'branch', c.branch))
  if (meta.length) { const p = el('p', 'meta'); p.append(...meta); li.append(p) }
  const links = (c.pr ? [Object.assign({ text: 'PR #' + c.pr.number }, c.pr)] : []).concat((c.issues || []).map((i) => Object.assign({ text: '#' + i.number }, i)))
  if (links.length) {
    const p = el('p', 'links')
    for (const l of links) {
      const label = l.state ? l.text + ' ' + l.state : l.text
      const ok = typeof l.url === 'string' && /^https?:\\/\\/github\\.com\\//.test(l.url)
      const a = el(ok ? 'a' : 'span', 'gh', label)
      if (ok) { a.href = l.url; a.target = '_blank'; a.rel = 'noreferrer' }
      p.append(a)
    }
    li.append(p)
  }
  if (c.marker) li.append(el('p', 'marker', c.marker))
  return li
}
const column = (col) => {
  const s = el('section', 'col'); s.dataset.stage = col.id
  const h = el('h2', null, col.title + ' '); h.append(el('span', 'count', String(col.cards.length)))
  const ul = el('ul'); ul.append(...col.cards.map(card)); s.append(h, ul)
  return s
}
const show = (msg) => { banner.textContent = msg; banner.hidden = !msg }
let last = null
async function poll() {
  try {
    const res = await fetch('state', { cache: 'no-store' })
    if (!(res.headers.get('content-type') || '').includes('json')) show('Board server answered HTTP ' + res.status + ' without board data. Showing the last good board.')
    else {
      const data = await res.json()
      if (!res.ok || data.error) show('Not updating: ' + (data.error || 'HTTP ' + res.status) + '. Showing the last good board.')
      else {
        show('')
        const key = JSON.stringify(data.columns)
        if (key !== last) { last = key; main.replaceChildren(...data.columns.map(column)) }
        sub.textContent = [data.defaultBranch && 'from ' + data.defaultBranch, data.generatedAt && 'generated ' + data.generatedAt].filter(Boolean).join(' · ')
        const n = data.githubNote || ''
        note.textContent = n; note.hidden = !n
      }
    }
  } catch { show('Board server not reachable. Showing the last good board.') }
  setTimeout(poll, 2000)
}
setTimeout(poll, 2000)
})()`

const LIVE_SCRIPT_HASH = createHash('sha256').update(LIVE_SCRIPT).digest('base64')

/**
 * Self-contained page: inline CSS, no external requests. With `live`, adds an error banner and a script
 * that polls `state` (same origin) every 2 s; without it the page has no script.
 */
export function renderHtml(board, { live = false } = {}) {
  const title = board.repoName ? `${board.repoName} board` : 'Board'
  const columns = board.columns.map((column) => `<section class="col" data-stage="${escapeHtml(column.id)}"><h2>${escapeHtml(column.title)} <span class="count">${column.cards.length}</span></h2><ul>${column.cards.map(renderCard).join('')}</ul></section>`).join('')
  const sub = subline(board)
  // The live page always has a subtitle element for the client to update.
  const subHtml = sub || live ? `<p class="sub">${escapeHtml(sub)}</p>` : ''
  const note = headerNote(board)
  const noteHtml = note || live ? `<p class="note"${note ? '' : ' hidden'}>${escapeHtml(note)}</p>` : ''
  const csp = live ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${LIVE_SCRIPT_HASH}'; connect-src 'self'` : "default-src 'none'; style-src 'unsafe-inline'"
  const liveCss = live ? '\n.banner{margin:0 16px 12px;padding:8px 10px;border-radius:6px;background:var(--warn-bg);color:var(--warn);font-size:12px;overflow-wrap:anywhere}' : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f6f6f4;--col:#ecebe7;--card:#fff;--text:#1d1d1b;--muted:#6b6a65;--line:#d9d8d2;--accent:#2f5d8a;--warn:#9a5b00;--warn-bg:#fbf0dc;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--col:#1f1f1d;--card:#2a2a27;--text:#ecebe7;--muted:#a19f97;--line:#3a3a36;--accent:#8db4dc;--warn:#e0a84a;--warn-bg:#33281a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:16px}header h1{margin:0;font-size:18px}header p{margin:4px 0 0;color:var(--muted);font-size:12px}${liveCss}
main{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;padding:0 16px 16px}
.col{background:var(--col);border-radius:8px;padding:10px;min-width:0}.col h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.count{color:var(--muted);font-weight:400}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px;overflow-wrap:anywhere}
.card h3{margin:0;font-size:14px;font-weight:600}.num{margin:0;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.meta{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px;font-size:12px}.progress{font-weight:600;color:var(--accent)}
.branch{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.marker{margin:6px 0 0;font-size:12px;color:var(--warn)}
.links{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px;font-size:12px}.gh{color:var(--muted)}a.gh{color:var(--accent)}header .note{color:var(--warn)}
@media (max-width:760px){main{grid-template-columns:1fr}}
</style></head>
<body><header><h1>${escapeHtml(title)}</h1>${subHtml}${noteHtml}</header>${live ? '<p id="banner" class="banner" role="status" hidden></p>' : ''}<main>${columns}</main>${live ? `<script>${LIVE_SCRIPT}</script>` : ''}</body></html>
`
}

export function defaultOutPath(repoRoot) {
  const common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  return join(common, 'flow', 'board.html')
}

const realRoot = (repoRoot) => { try { return realpathSync(repoRoot) } catch { return resolve(repoRoot) } }

/**
 * Probes 127.0.0.1:<port>/state. Returns `{ url, pid }` when this repository's board answers there, or null
 * for nothing, another repository's board, or any other service. Nothing is recorded on disk.
 */
async function findBoard(repoRoot, port) {
  const url = `http://127.0.0.1:${port}/`
  try {
    const res = await fetch(new URL('state', url), { signal: AbortSignal.timeout(1500) })
    if (!(res.headers.get('content-type') ?? '').includes('json')) { await res.body?.cancel(); return null }
    const { server } = await res.json()
    if (!Number.isInteger(server?.pid) || typeof server.repoRoot !== 'string') return null
    return realRoot(server.repoRoot) === realRoot(repoRoot) ? { url, pid: server.pid } : null
  } catch { return null }
}

const firstLines = (message) => String(message).split('\n').slice(0, 2).join(' ').slice(0, 300)

/**
 * Serves the live board on 127.0.0.1: `/` is the page, `/state` the derived board as JSON. The board is
 * recomputed at most once per `memoMs`, however many tabs poll. A git failure after start makes `/state`
 * answer 500 `{ error }`; the page keeps its last good board and shows a banner. Every `/state` body
 * carries `server: { repoRoot, pid }` so `--serve` and `--stop` can recognize this repository's board.
 * `github` (a githubSource, or null) adds GitHub links. It refreshes in the background on its own longer
 * cache, so a request never waits on `gh` and polling stays off the GitHub API; links fill in once it resolves.
 * Throws when the first derivation fails; rejects when the port cannot be bound. `now` is the memo clock (tests).
 */
export async function startServer({ repoRoot, port = 0, memoMs = 1000, github = null, now = Date.now }) {
  const identity = { repoRoot: realRoot(repoRoot), pid: process.pid }
  let lastGood = deriveBoard(readSnapshot(repoRoot, { github }))
  let memo = { at: now(), value: { status: 200, body: { ...lastGood, server: identity } } }
  const state = () => {
    if (now() - memo.at < memoMs) return memo.value
    let value
    try {
      lastGood = deriveBoard(readSnapshot(repoRoot, { github }))
      value = { status: 200, body: { ...lastGood, server: identity } }
    } catch (error) {
      value = { status: 500, body: { error: firstLines(error.message), server: identity } }
    }
    memo = { at: now(), value }
    return value
  }
  let allowedHosts = []
  const server = createServer((req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    // Same-machine hostnames only: blocks DNS-rebinding reads from other sites.
    if (!allowedHosts.includes(req.headers.host)) return send(403, 'text/plain', 'Forbidden\n')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Method not allowed\n')
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/state') {
      const { status, body } = state()
      return send(status, 'application/json; charset=utf-8', JSON.stringify(body))
    }
    if (path === '/') {
      state()
      return send(200, 'text/html; charset=utf-8', renderHtml(lastGood, { live: true }))
    }
    return send(404, 'text/plain', 'Not found\n')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen() })
  })
  const bound = server.address().port
  allowedHosts = [`127.0.0.1:${bound}`, `localhost:${bound}`]
  const url = `http://127.0.0.1:${bound}/`
  const close = () => new Promise((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections() })
  return { server, url, close }
}

export const DEFAULT_PORT = 4178
// While serving, GitHub data is refetched at most once a minute, separate from the 1 s git memo.
const GITHUB_TTL_MS = 60_000

function parseArgs(argv) {
  const args = { once: false, json: false, serve: false, stop: false, github: true, port: null, out: null, repo: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--once') args.once = true
    else if (arg === '--json') args.json = true
    else if (arg === '--serve') args.serve = true
    else if (arg === '--stop') args.stop = true
    else if (arg === '--no-github') args.github = false
    else if (arg === '--out' || arg === '--repo' || arg === '--port') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      args[arg.slice(2)] = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (args.port !== null) {
    const port = Number(args.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535: ${args.port}`)
    args.port = port
  }
  if (Number(args.serve) + Number(args.stop) + Number(args.once || args.json) > 1) throw new Error('--serve, --stop, and --once/--json are separate modes')
  return args
}

async function serve(repoRoot, port, github) {
  const running = port === 0 ? null : await findBoard(repoRoot, port ?? DEFAULT_PORT)
  if (running) { console.log(`Board already running at ${running.url} (pid ${running.pid}).`); return 0 }
  let live
  try {
    try {
      live = await startServer({ repoRoot, port: port ?? DEFAULT_PORT, github })
    } catch (error) {
      // The fixed default keeps the URL stable across restarts; fall back to any free port when it is taken.
      if (error.code !== 'EADDRINUSE' || port !== null) throw error
      live = await startServer({ repoRoot, port: 0, github })
    }
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use.` : error.message)
    return 1
  }
  console.log(`Board at ${live.url} (pid ${process.pid}). Stop with --stop, Ctrl-C, or kill ${process.pid}.`)
  return new Promise((resolveExit) => {
    const stop = () => { live.close().then(() => resolveExit(0)) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

async function stopServer(repoRoot, port) {
  const target = port ?? DEFAULT_PORT
  const running = target === 0 ? null : await findBoard(repoRoot, target)
  if (!running) { console.log(`No board for this repo on port ${target}.`); return 0 }
  process.kill(running.pid, 'SIGTERM')
  console.log(`Stopped the board at ${running.url} (pid ${running.pid}).`)
  return 0
}

/** Resolves to the exit code; with `--serve`, once the server stops on SIGINT or SIGTERM. `error` is the error reporter (tests). */
export async function main(argv = process.argv.slice(2), { error: report = console.error } = {}) {
  const usage = 'Usage: board.mjs --serve [--port <n>] [--repo <path>] [--no-github] | --stop [--port <n>] [--repo <path>] | --once [--out <file>] [--repo <path>] [--no-github] | --json [--repo <path>] [--no-github]'
  let args
  try { args = parseArgs(argv) } catch (error) { report(`${error.message}\n${usage}`); return 2 }
  if (!args.once && !args.json && !args.serve && !args.stop) { report(usage); return 2 }
  const repoRoot = tryGit(resolve(args.repo), ['rev-parse', '--show-toplevel'])
  if (!repoRoot) { report(`Not inside a git repository: ${args.repo}`); return 1 }
  if (args.serve) return serve(repoRoot, args.port, args.github ? githubSource({ ttlMs: GITHUB_TTL_MS }) : null)
  if (args.stop) return stopServer(repoRoot, args.port)
  let board
  try { board = deriveBoard(readSnapshot(repoRoot, { github: args.github ? githubReader() : null })) } catch (error) { report(error.message); return 1 }
  if (args.json) console.log(JSON.stringify(board, null, 2))
  if (args.once) {
    const out = args.out ? (isAbsolute(args.out) ? args.out : resolve(args.out)) : defaultOutPath(repoRoot)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, renderHtml(board))
    console.log(out)
  }
  return 0
}

if (process.argv[1] && realRoot(process.argv[1]) === realRoot(fileURLToPath(import.meta.url))) process.exitCode = await main()
