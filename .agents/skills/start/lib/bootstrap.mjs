// Runs the bootstrap lane on a destination that already holds the template (copied, or a template checkout):
// drop template remotes, rename, `pnpm setup`, baseline docs, Flow block, format, checks, and the gated initial commit.
// CLI: node bootstrap.mjs <destination> <project-name> [--preset minimal|neon]; prints the completion facts as JSON.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baselineDocsRejectFlowIdentity, buildBaselineDocs } from './baseline-docs.mjs'
import { canCreateInitialCommit, formatInitialCommitMessage } from './commit-gate.mjs'
import { TEMPLATE_IDS } from './constants.mjs'
import { isTemplateRemoteUrl } from './git-safety.mjs'
import { resolvePreset } from './preset.mjs'
import { deriveProjectIdentity } from './identity.mjs'
import { applyRenamesInTree, scanTreeForStaleIdentifiers } from './rename.mjs'

const IGNORED_ARTIFACTS = ['.env.local', 'node_modules/', '.next/']

// Staged paths the initial commit must never carry: env files with values, keys, local links, and build output.
const UNSAFE_STAGED = [
  /(^|\/)\.env(\.[^/]*)?$/u,
  /(^|\/)\.dev\.vars$/u,
  /\.pem$/u,
  /(^|\/)\.vercel\//u,
  /(^|\/)(node_modules|\.next|dist|\.turbo)\//u,
  /(^|\/)\.DS_Store$/u,
]
export const unsafeStagedPaths = (paths) =>
  paths.filter((path) => !/\.example$/u.test(path) && UNSAFE_STAGED.some((pattern) => pattern.test(path)))

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const tryGit = (cwd, args) => {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.message ?? error).trim() }
  }
}

const defaultRun = ({ cwd, script, env }) => {
  try {
    execFileSync('pnpm', [script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe' })
    return { status: 'passed', detail: '' }
  } catch (error) {
    return { status: 'failed', detail: `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(-2000) }
  }
}

// The Flow block belongs to the `flow` skill; without it the block is skipped and reported.
const loadFlowBlock = async () => {
  try {
    return await import(new URL('../../flow/lib/flow-block.mjs', import.meta.url))
  } catch {
    return null
  }
}

export const runBootstrap = async ({ destinationPath: given, projectName, preset: requested, run = defaultRun }) => {
  const destinationPath = resolve(given ?? '')
  const report = { destination: destinationPath, checks: [], blockers: [] }
  const block = (reason) => ({ ...report, ok: false, blockers: [...report.blockers, reason] })

  const presetResult = resolvePreset({ explicit: requested ?? 'minimal' })
  if (!presetResult.ok) return block(presetResult.error)
  const { preset } = presetResult
  report.preset = preset

  const pkgFile = join(destinationPath, 'package.json')
  const template = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')).name : undefined
  if (!TEMPLATE_IDS.includes(template)) return block(`package.json name is not a template id (${template ?? 'missing'}).`)
  report.template = template

  const derived = deriveProjectIdentity({ projectName })
  if (!derived.ok) return block(derived.reason)
  const { identity } = derived
  report.identity = identity

  if (!existsSync(join(destinationPath, '.git'))) git(destinationPath, ['init', '-q'])
  const head = tryGit(destinationPath, ['rev-parse', '--short', 'HEAD'])
  report.templateSha = head.ok ? head.out : 'unknown'

  report.removedRemotes = []
  for (const line of (tryGit(destinationPath, ['remote', '-v']).out || '').split('\n').filter(Boolean)) {
    const [name, url] = line.split(/\s+/u)
    if (isTemplateRemoteUrl(url) && !report.removedRemotes.includes(name)) {
      git(destinationPath, ['remote', 'remove', name])
      report.removedRemotes.push(name)
    }
  }

  const renamed = applyRenamesInTree({ root: destinationPath, template, identity })
  if (!renamed.ok) return block(renamed.reason ?? 'rename refused')
  report.renamed = renamed.updated

  const setup = run({ cwd: destinationPath, script: 'setup', env: { FLOW_PRESET: preset } })
  report.checks.push({ id: 'setup', ...setup })

  const docs = buildBaselineDocs({
    projectName: identity.displayTitle,
    slug: identity.slug,
    template,
    templateSha: report.templateSha,
    portlessHost: identity.portlessHost,
  })
  report.docs = { created: [], kept: [] }
  for (const [file, text] of Object.entries(docs)) {
    const target = join(destinationPath, file)
    if (existsSync(target)) report.docs.kept.push(file)
    else {
      writeFileSync(target, text)
      report.docs.created.push(file)
    }
  }
  const flowIdentity = baselineDocsRejectFlowIdentity(docs)
  if (!flowIdentity.ok) return block(flowIdentity.reason)

  const flow = await loadFlowBlock()
  if (flow) {
    report.flowBlock = flow.writeFlowBlock(destinationPath, {})
    if (report.flowBlock.refused) return block(`Flow block refused: ${report.flowBlock.refused}`)
    report.flowImport = flow.ensureImport(destinationPath)
    if (report.flowImport.refused) return block(`@AGENTS.md import refused: ${report.flowImport.refused}`)
  } else report.flowBlock = { skipped: 'flow skill not installed' }

  const scripts = JSON.parse(readFileSync(pkgFile, 'utf8')).scripts ?? {}
  if (scripts.format) report.format = run({ cwd: destinationPath, script: 'format' }).status

  report.checks.push({ id: 'qa', ...run({ cwd: destinationPath, script: 'qa' }) })
  const stale = scanTreeForStaleIdentifiers({ root: destinationPath, template })
  report.checks.push({ id: 'identity_scan', status: stale.length ? 'failed' : 'passed', detail: JSON.stringify(stale) })
  const notIgnored = IGNORED_ARTIFACTS.filter((path) => !tryGit(destinationPath, ['check-ignore', '-q', path]).ok)
  report.checks.push({
    id: 'gitignore_artifacts',
    status: notIgnored.length ? 'failed' : 'passed',
    detail: notIgnored.length ? `not ignored: ${notIgnored.join(', ')}` : '',
  })

  const gate = canCreateInitialCommit({ checkResults: report.checks })
  if (!gate.ok) return block(gate.reason)
  if (flow) {
    const layout = flow.describeLayout(destinationPath)
    if (!layout.tracked) return block(`Flow block file is not tracked by Git: ${layout.blockFile}`)
  }

  git(destinationPath, ['add', '-A'])
  const unsafe = unsafeStagedPaths(git(destinationPath, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean))
  if (unsafe.length) {
    git(destinationPath, ['reset', '-q'])
    return block(`refusing to commit secrets or build output: ${unsafe.join(', ')}`)
  }
  const commit = tryGit(destinationPath, ['commit', '-q', '-m', formatInitialCommitMessage({ slug: identity.slug })])
  if (!commit.ok) return block(`initial commit failed: ${commit.out.slice(-1000)}`)
  report.initialCommit = git(destinationPath, ['rev-parse', 'HEAD'])
  report.clean = git(destinationPath, ['status', '--porcelain']) === ''
  return { ...report, ok: report.clean }
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
  const [destinationPath, projectName, ...rest] = process.argv.slice(2)
  const presetIndex = rest.indexOf('--preset')
  const preset = presetIndex === -1 ? 'minimal' : (rest[presetIndex + 1] ?? 'missing')
  const result = await runBootstrap({ destinationPath, projectName, preset })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
