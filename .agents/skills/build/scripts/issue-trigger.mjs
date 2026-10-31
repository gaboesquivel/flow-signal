#!/usr/bin/env node
// Issue trigger gate: decides whether a `build-it` label authorizes a build, and returns the only issue text that counts.
//   node issue-trigger.mjs <issue> [--repo owner/name]
// Prints JSON. Exit 0 only when authorized; 1 when refused; 2 when GitHub could not be read (refused too: fail closed).
// Reads through `gh api` REST, which works behind proxies that refuse GraphQL. Zero dependencies, Node >= 22.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const LABEL = 'build-it'
const WRITERS = new Set(['write', 'admin'])
const PAGE = 100
const MAX_PAGES = 10

export class ReadError extends Error {}

// Every page of a REST list.
export function pages(api, path) {
  const out = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = api(`${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`)
    if (!Array.isArray(items)) throw new ReadError(`unexpected response for ${path}`)
    out.push(...items)
    if (items.length < PAGE) return out
  }
  throw new ReadError(`more than ${MAX_PAGES * PAGE} entries at ${path}`)
}

// write, admin, read, or null when no route can tell. A user-owned repository's owner is its admin.
export function permissionReader(api, repo, owner) {
  const cache = new Map()
  let list
  return (login) => {
    if (cache.has(login)) return cache.get(login)
    let level = null
    if (owner?.type === 'User' && owner.login === login) level = 'admin'
    if (!level) {
      try { level = api(`repos/${repo}/collaborators/${login}/permission`).permission ?? null } catch {}
    }
    if (!level) {
      try {
        list ??= pages(api, `repos/${repo}/collaborators?affiliation=all`)
        const p = list.find((c) => c.login === login)?.permissions
        level = !list ? null : !p ? 'read' : p.admin ? 'admin' : p.push || p.maintain ? 'write' : 'read'
      } catch {}
    }
    cache.set(login, level)
    return level
  }
}

const refuse = (reason) => ({ ok: false, reason })

export function check({ api, repo, number }) {
  let issue
  try { issue = api(`repos/${repo}/issues/${number}`) } catch (e) { throw new ReadError(`cannot read issue #${number}: ${e.message}`) }
  if (issue.pull_request) return refuse(`#${number} is a pull request, not an issue`)
  if (issue.state !== 'open') return refuse(`issue #${number} is ${issue.state}`)
  if (!issue.labels?.some((l) => (l.name ?? l) === LABEL)) return refuse(`the ${LABEL} label is not on issue #${number}`)
  const events = pages(api, `repos/${repo}/issues/${number}/events`)
  const last = events.filter((e) => e.event === 'labeled' && e.label?.name === LABEL).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
  if (!last?.actor?.login) return refuse(`no ${LABEL} label event found on issue #${number}`)
  let owner
  try { owner = api(`repos/${repo}`).owner } catch {}
  const permission = permissionReader(api, repo, owner)
  const labeler = last.actor.login
  const level = permission(labeler)
  if (level === null) throw new ReadError(`cannot read ${labeler}'s permission on ${repo}`)
  if (!WRITERS.has(level)) return refuse(`${labeler} added ${LABEL} with ${level} permission; it needs write or admin`)
  const author = issue.user?.login
  if (!author) return refuse(`issue #${number} has no readable author`)
  const authorLevel = permission(author)
  if (authorLevel === null) throw new ReadError(`cannot read the issue author's permission on ${repo}`)
  if (!WRITERS.has(authorLevel)) return refuse(`issue #${number} was written by ${author} (${authorLevel}); a writer must open the issue and label it`)
  const comments = pages(api, `repos/${repo}/issues/${number}/comments`)
    .filter((c) => c.user?.login && WRITERS.has(permission(c.user.login) ?? ''))
    .map((c) => ({ author: c.user.login, at: c.created_at, body: c.body ?? '' }))
  return {
    ok: true,
    issue: number,
    labeler,
    permission: level,
    labeledAt: last.created_at,
    task: { title: issue.title, body: issue.body ?? '', comments },
  }
}

// github.com remotes, and host git proxies that keep `/git/<owner>/<repo>` in the path.
export const repoFromRemote = (url) => /(?:github\.com[:/]|\/git\/)([^/]+\/[^/]+?)(?:\.git)?\s*$/u.exec(url ?? '')?.[1] ?? null

function main(argv) {
  const repoAt = argv.indexOf('--repo')
  let origin = null
  try { origin = repoFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) } catch {}
  const repo = repoAt >= 0 ? argv[repoAt + 1] : origin
  const number = Number(argv.find((a, i) => /^#?\d+$/u.test(a) && argv[i - 1] !== '--repo')?.replace('#', ''))
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo ?? '') || (origin && repo.toLowerCase() !== origin.toLowerCase()) || !Number.isInteger(number)) {
    console.log(JSON.stringify(refuse('usage: issue-trigger.mjs <issue> [--repo owner/name, matching origin]')))
    return 1
  }
  const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }))
  try {
    const result = check({ api, repo, number })
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  } catch (e) {
    console.log(JSON.stringify(refuse(e instanceof ReadError ? e.message : `cannot read GitHub: ${e.message}`)))
    return 2
  }
}

// Skills are often reached through a symlinked directory (`.claude/skills`), so compare real paths.
const real = (path) => { try { return realpathSync(path) } catch { return path } }
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2))
