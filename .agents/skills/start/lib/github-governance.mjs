// Flow's GitHub governance preset: one definition, applied idempotently and verified through `gh api`.
// CLI: node github-governance.mjs <owner/repo> [--check <name>]... [--verify-only]; prints the report as JSON.
// Without --check, the checks the Flow ruleset already requires are kept (the template's on a first run).
// Exit 0 when the protected default branch, merge policy, and Actions permissions are verified.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const RULESET_NAME = 'Flow main'

// The jobs flow-next and flow-mono run on every pull request; repositories created from them inherit both.
export const TEMPLATE_REQUIRED_CHECKS = ['verify', 'pr-title']

const GITHUB_ACTIONS_APP_ID = 15368
const VERCEL_APP_ID = 8329
const PR_TITLE_WORKFLOW = '.github/workflows/pr-title.yml'

// Squash-only with the PR title as the commit subject; merged branches are deleted.
export const REPO_SETTINGS = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
  delete_branch_on_merge: true,
  allow_update_branch: true,
}

// GITHUB_TOKEN reads by default and can never approve a pull request.
export const WORKFLOW_PERMISSIONS = { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }

// Each required check is pinned to the app that reports it, so no other actor can post a passing status.
const checkEntry = (context) => ({ context, integration_id: context === 'Vercel' ? VERCEL_APP_ID : GITHUB_ACTIONS_APP_ID })

// No bypass actors: admins and agents alike merge through a green pull request. Zero approvals keeps solo work moving.
export const rulesetBody = ({ checks }) => ({
  name: RULESET_NAME,
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_linear_history' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        allowed_merge_methods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: checks.map(checkEntry),
      },
    },
  ],
})

const httpStatus = (text) => Number(/\(HTTP (\d{3})\)/u.exec(text)?.[1] ?? 0)

export const defaultGh = (path, { method = 'GET', body } = {}) => {
  const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json']
  if (body) args.push('--input', '-')
  try {
    const out = execFileSync('gh', args, { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', stdio: 'pipe' })
    return { ok: true, status: 200, json: out.trim() ? JSON.parse(out) : null }
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { ok: false, status: httpStatus(text), error: text.trim().slice(-500) }
  }
}

// 404 on an admin endpoint means the token cannot administer the repository; plan limits answer 403 or 422 with an upgrade hint.
const UNSUPPORTED = /upgrade|GitHub Pro|not available|Advanced Security/iu
const classify = (result) => {
  if (UNSUPPORTED.test(result.error ?? '')) return 'unsupported'
  if ([401, 403, 404].includes(result.status)) return 'missing-permission'
  return 'failed'
}

const mismatches = (actual, expected) =>
  Object.entries(expected)
    .filter(([key, value]) => actual?.[key] !== value)
    .map(([key, value]) => `${key}: ${JSON.stringify(actual?.[key])} (want ${JSON.stringify(value)})`)

// Effective rules on the default branch, from every active ruleset, must add up to the preset.
export const verifyEffectiveRules = ({ rules, checks }) => {
  const problems = []
  const types = new Set(rules.map((rule) => rule.type))
  for (const type of ['deletion', 'non_fast_forward', 'required_linear_history', 'pull_request', 'required_status_checks'])
    if (!types.has(type)) problems.push(`missing rule ${type}`)
  for (const rule of rules.filter((r) => r.type === 'pull_request')) {
    const methods = rule.parameters?.allowed_merge_methods ?? []
    if (methods.some((method) => method !== 'squash')) problems.push(`a ruleset still allows ${methods.join(', ')}`)
  }
  const required = new Set(
    rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters.required_status_checks.map((c) => c.context)),
  )
  for (const check of checks) if (!required.has(check)) problems.push(`check ${check} not required`)
  return problems
}

// Without `checks`, a rerun keeps the checks the Flow ruleset already requires; a new ruleset gets the template's.
export const applyGovernance = ({ repo, checks: named, verifyOnly = false, gh = defaultGh }) => {
  const report = { repo, settings: [], unsupported: [], missingPermissions: [], notes: [] }
  const record = (id, status, detail = '') => {
    report.settings.push({ id, status, detail })
    if (status === 'unsupported') report.unsupported.push(id)
    if (status === 'missing-permission') report.missingPermissions.push(id)
  }
  const step = (id, write, verify) => {
    if (!verifyOnly) {
      const result = write()
      if (!result.ok) return record(id, classify(result), result.error)
    }
    const problems = verify()
    const detail = problems.join('; ')
    if (!problems.length) record(id, 'verified')
    else record(id, UNSUPPORTED.test(detail) ? 'unsupported' : verifyOnly ? 'differs' : 'failed', detail)
  }

  const meta = gh(`repos/${repo}`)
  if (!meta.ok) {
    record('repository', classify(meta), meta.error)
    return { ...report, ok: false }
  }
  if (!meta.json.permissions?.admin) {
    record('repository', 'missing-permission', 'the authenticated user is not an admin of this repository')
    return { ...report, ok: false }
  }
  const branch = meta.json.default_branch
  const isPublic = meta.json.visibility === 'public'
  report.defaultBranch = branch

  step(
    'merge-policy',
    () => gh(`repos/${repo}`, { method: 'PATCH', body: REPO_SETTINGS }),
    () => mismatches(gh(`repos/${repo}`).json, REPO_SETTINGS),
  )
  step(
    'actions-permissions',
    () => gh(`repos/${repo}/actions/permissions/workflow`, { method: 'PUT', body: WORKFLOW_PERMISSIONS }),
    () => mismatches(gh(`repos/${repo}/actions/permissions/workflow`).json, WORKFLOW_PERMISSIONS),
  )
  step(
    'dependabot-alerts',
    () => gh(`repos/${repo}/vulnerability-alerts`, { method: 'PUT' }),
    () => (gh(`repos/${repo}/vulnerability-alerts`).ok ? [] : ['disabled']),
  )
  const scanning = { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } }
  step(
    'secret-scanning',
    () => gh(`repos/${repo}`, { method: 'PATCH', body: { security_and_analysis: scanning } }),
    () => {
      // GitHub omits features the plan does not offer.
      const actual = gh(`repos/${repo}`).json?.security_and_analysis ?? {}
      return Object.keys(scanning)
        .filter((key) => actual[key]?.status !== 'enabled')
        .map((key) => (actual[key] ? `${key} disabled` : `${key} not available on this plan`))
    },
  )
  if (isPublic)
    step(
      'private-vulnerability-reporting',
      () => gh(`repos/${repo}/private-vulnerability-reporting`, { method: 'PUT' }),
      () => (gh(`repos/${repo}/private-vulnerability-reporting`).json?.enabled ? [] : ['disabled']),
    )

  const listed = gh(`repos/${repo}/rulesets`)
  const existing = listed.ok ? listed.json.find((ruleset) => ruleset.name === RULESET_NAME) : undefined
  const current = existing && gh(`repos/${repo}/rulesets/${existing.id}`).json
  const kept = current?.rules
    ?.find((rule) => rule.type === 'required_status_checks')
    ?.parameters.required_status_checks.map((check) => check.context)
  let checks = named?.length ? named : kept?.length ? kept : TEMPLATE_REQUIRED_CHECKS
  // pr-title only reports where its workflow exists; requiring it elsewhere would block every pull request.
  if (checks.includes('pr-title') && !gh(`repos/${repo}/contents/${PR_TITLE_WORKFLOW}?ref=${encodeURIComponent(branch)}`).ok) {
    checks = checks.filter((check) => check !== 'pr-title')
    record('pr-title-workflow', 'failed', `${PR_TITLE_WORKFLOW} is missing on ${branch}; pr-title is not required until it lands`)
  }
  report.checks = checks
  if (listed.ok)
    for (const other of listed.json.filter((ruleset) => ruleset.name !== RULESET_NAME))
      report.notes.push(`another ruleset is active: ${other.name} (#${other.id}); its rules add to ${RULESET_NAME}`)
  step(
    'ruleset',
    () => {
      if (!listed.ok) return listed
      const body = rulesetBody({ checks })
      return existing
        ? gh(`repos/${repo}/rulesets/${existing.id}`, { method: 'PUT', body })
        : gh(`repos/${repo}/rulesets`, { method: 'POST', body })
    },
    () => {
      const effective = gh(`repos/${repo}/rules/branches/${encodeURIComponent(branch)}`)
      if (!effective.ok) return [`cannot read effective rules: ${effective.error}`]
      const problems = verifyEffectiveRules({ rules: effective.json, checks })
      const own = gh(`repos/${repo}/rulesets`).json?.find((ruleset) => ruleset.name === RULESET_NAME)
      const full = own && gh(`repos/${repo}/rulesets/${own.id}`).json
      if (!full) problems.push(`${RULESET_NAME} ruleset missing`)
      else if (full.bypass_actors?.length || full.current_user_can_bypass !== 'never')
        problems.push('someone can bypass the ruleset')
      return problems
    },
  )

  // A required check that never reports blocks every pull request; say so instead of failing quietly.
  const head = gh(`repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`)
  const statuses = gh(`repos/${repo}/commits/${encodeURIComponent(branch)}/statuses?per_page=100`)
  const seen = new Set([
    ...(head.ok ? head.json.check_runs.map((run) => run.name) : []),
    ...(statuses.ok ? statuses.json.map((status) => status.context) : []),
  ])
  const unseen = checks.filter((check) => !seen.has(check) && check !== 'pr-title')
  if (unseen.length) report.notes.push(`not yet reported on ${branch}: ${unseen.join(', ')}`)

  const essential = new Set(['merge-policy', 'actions-permissions', 'ruleset'])
  report.ok = report.settings.filter((s) => essential.has(s.id)).every((s) => s.status === 'verified')
  return report
}

// realpath on both sides: skills are often installed behind symlinks (.claude/skills), where argv[1] keeps the link path.
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const [repo, ...rest] = process.argv.slice(2)
  // Check names may hold commas (matrix jobs), so each one is its own --check.
  const named = rest.flatMap((arg, index) => (arg === '--check' && rest[index + 1] ? [rest[index + 1]] : []))
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo ?? '')) {
    console.error('usage: node github-governance.mjs <owner/repo> [--check <name>]... [--verify-only]')
    process.exit(2)
  }
  const result = applyGovernance({ repo, checks: named, verifyOnly: rest.includes('--verify-only') })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
