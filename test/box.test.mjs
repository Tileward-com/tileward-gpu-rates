/**
 * Tests for the host-side job (box/) and the workflow that opens the pull request. The runner is exercised
 * against a local bare repository standing in for GitHub, a stub notifier, and a stub `node` that pretends to
 * be refresh/run.mjs with a chosen outcome, so no network is touched and the shell logic that holds the
 * credentials (what it pushes, where, and what it tells a person) is the thing under test.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const SCRIPTS = ['box/run-weekly.sh', 'box/install.sh', 'box/uninstall.sh']
const WORKFLOWS = ['.github/workflows/validate.yml', '.github/workflows/open-refresh-pr.yml']

// ---------------------------------------------------------------------------------- static guards

test('the box scripts parse', () => {
  for (const f of SCRIPTS) {
    const r = spawnSync('bash', ['-n', join(root, f)], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${f}: ${r.stderr}`)
  }
})

test('nothing in the public repository names an internal host, container or credential', () => {
  const files = [...SCRIPTS, ...WORKFLOWS, 'README.md', 'AGENT_TASK.md', 'refresh/run.mjs', 'refresh/sources.mjs', 'refresh/lib.mjs', 'refresh/pr-body.mjs', 'refresh/rows.json']
  // The internal names are assembled from pieces so this list does not itself put them in the public repository.
  const word = (...parts) => new RegExp(parts.join(''), 'i')
  const forbidden = [
    word('log', 'cabin'), word('tele', 'gram'), word('tw-', 'prod'), /\bi-0[0-9a-f]{8,}/, /\.internal\b/, /\/Users\//,
    /BEGIN [A-Z ]*PRIVATE KEY/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/,
  ]
  for (const f of files) for (const re of forbidden) assert.doesNotMatch(read(f), re, `${f} matches ${re}`)
})

test('nothing here merges, and the host pushes only the heartbeat and its own refresh branch', () => {
  const all = [...SCRIPTS, ...WORKFLOWS].map(read).join('\n')
  assert.doesNotMatch(all, /pr merge|--auto\b|\/merge\b|merge --/)
  const pushes = read('box/run-weekly.sh').split('\n').filter((l) => !/^\s*#/.test(l) && /git .*\bpush\b/.test(l))
  assert.equal(pushes.length, 2)
  for (const l of pushes) assert.match(l, /agent-heartbeat|refs\/heads\/\$BRANCH/, `an unexpected push: ${l}`)
})

test('the workflow that opens the pull request runs for refresh branches only, with no write to contents', () => {
  const y = read('.github/workflows/open-refresh-pr.yml')
  assert.match(y, /branches: \['refresh\/box-\*'\]/)
  assert.match(y, /permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: write/)
  assert.doesNotMatch(y, /contents: write/)
  assert.match(y, /!= "gpu-rates\.json"/, 'it refuses a branch that changes anything but the data')
  assert.match(y, /--label gpu-rates/)
})

test('the gate runs on pull requests, on main and on refresh branches, as the check named validate', () => {
  const y = read('.github/workflows/validate.yml')
  assert.match(y, /pull_request:/)
  assert.match(y, /branches: \[main, 'refresh\/box-\*'\]/)
  assert.match(y, /^  validate:/m)
})

// ----------------------------------------------------------------------------------- the runner

const STUB_NODE = `#!/bin/bash
# stands in for "node refresh/run.mjs --write --report R --heartbeat H"
while [ $# -gt 0 ]; do case "$1" in --report) R=$2; shift;; --heartbeat) H=$2; shift;; esac; shift; done
case "\${FAKE_REFRESH:-clean}" in
  clean)
    echo '{"schema":1}' >"$R"; echo '{"checked":"2026-10-12T07:00:00Z","changed":false,"read":31,"total":31,"unread":[]}' >"$H"
    echo 'No change needed: every price was read and matches.'; exit 0 ;;
  changed)
    sed -i.bak 's/"usd": 6.88/"usd": 7.01/' gpu-rates.json && rm -f gpu-rates.json.bak
    echo '{"schema":1}' >"$R"; echo '{"checked":"2026-10-12T07:00:00Z","changed":true,"read":31,"total":31,"unread":[]}' >"$H"
    echo 'Change proposed.'; echo '  changed  aws/h100: $6.88 -> $7.01   [p5.48xlarge ...]'; exit 10 ;;
  partial)
    echo '{"schema":1}' >"$R"; echo '{"checked":"2026-10-12T07:00:00Z","changed":false,"read":29,"total":31,"unread":["aws/l4","aws/h100"]}' >"$H"
    echo '  not read aws/l4: could not read b0.p.awsstatic.com: connect ECONNREFUSED'; exit 11 ;;
  claimed-change-but-none)
    echo '{"schema":1}' >"$R"; echo '{"checked":"x","changed":true,"read":31,"total":31,"unread":[]}' >"$H"; exit 10 ;;
  crash) echo 'boom' >&2; exit 1 ;;
esac
`

function rig() {
  const d = mkdtempSync(join(tmpdir(), 'gpurates-box-'))
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  const git = (...a) => sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  assert.equal(sh('git', ['init', '-q', '--bare', '-b', 'main', join(d, 'origin.git')]).status, 0)
  mkdirSync(join(d, 'seed'))
  copyFileSync(join(root, 'gpu-rates.json'), join(d, 'seed/gpu-rates.json'))
  git('-C', join(d, 'seed'), 'init', '-q', '-b', 'main')
  git('-C', join(d, 'seed'), 'add', '-A')
  git('-C', join(d, 'seed'), 'commit', '-q', '-m', 'seed')
  assert.equal(git('-C', join(d, 'seed'), 'push', '-q', join(d, 'origin.git'), 'main').status, 0)
  mkdirSync(join(d, 'bin'))
  writeFileSync(join(d, 'bin/node'), STUB_NODE); chmodSync(join(d, 'bin/node'), 0o755)
  writeFileSync(join(d, 'notify.sh'), '#!/bin/bash\ncat >>"$STUB_OUT/sent.txt"; printf "\\n=====\\n" >>"$STUB_OUT/sent.txt"\n'); chmodSync(join(d, 'notify.sh'), 0o755)
  writeFileSync(join(d, 'find-pr.sh'), '#!/bin/bash\necho "https://example.test/pull/7"\n'); chmodSync(join(d, 'find-pr.sh'), 0o755)
  const run = (mode, extra = {}) =>
    sh('bash', [join(root, 'box/run-weekly.sh')], {
      env: {
        PATH: `${join(d, 'bin')}:${process.env.PATH}`, HOME: d, STUB_OUT: d, FAKE_REFRESH: mode,
        GPU_RATES_DIR: join(d, 'box'), GPU_RATES_REMOTE: join(d, 'origin.git'), GPU_RATES_RUNNER: 'host',
        GPU_RATES_NOTIFY: join(d, 'notify.sh'), GPU_RATES_FIND_PR: join(d, 'find-pr.sh'), GPU_RATES_PR_WAIT_SECONDS: '0',
        ...extra,
      },
    })
  const origin = (...a) => sh('git', ['-C', join(d, 'origin.git'), ...a]).stdout.trim()
  const sent = () => { try { return readFileSync(join(d, 'sent.txt'), 'utf8') } catch { return '' } }
  const messages = () => sent().split('\n=====\n').filter(Boolean)
  return { d, run, origin, sent, messages }
}
const branches = (o) => o('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort()

test('runner: nothing to change writes a heartbeat and says nothing', () => {
  const r = rig()
  const res = r.run('clean')
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(branches(r.origin), ['agent-heartbeat', 'main'])
  assert.deepEqual(r.origin('ls-tree', '--name-only', 'agent-heartbeat').split('\n'), ['heartbeat.json', 'report.json'])
  assert.match(r.origin('show', 'agent-heartbeat:heartbeat.json'), /"read":31,"total":31,"unread":\[\]/)
  assert.equal(r.messages().length, 0)
})

test('runner: a change goes to a refresh branch as one data-only commit, the person gets the link, and a rerun is quiet', () => {
  const r = rig()
  const res = r.run('changed')
  assert.equal(res.status, 0, res.stderr)
  const branch = branches(r.origin).find((b) => b.startsWith('refresh/box-'))
  assert.match(branch, /^refresh\/box-\d{4}-\d{2}-\d{2}$/)
  assert.equal(r.origin('log', '--format=%s|%b', `main..${branch}`), 'GPU rates refresh: 1 changed|', 'one short subject, no body')
  assert.equal(r.origin('rev-list', '--count', `main..${branch}`), '1')
  assert.equal(r.origin('diff', '--name-only', 'main', branch), 'gpu-rates.json')
  assert.match(r.origin('show', `${branch}:gpu-rates.json`), /"provider": "aws", "usd": 7\.01/)
  assert.match(r.origin('log', '-1', '--format=%ae', branch), /noreply@tileward\.com/)
  assert.equal(r.messages().length, 1)
  assert.match(r.messages()[0], /GPU prices: 1 changed\. Review it, then merge to publish or close to reject:\nhttps:\/\/example\.test\/pull\/7/)
  assert.match(r.messages()[0], /changed {2}aws\/h100: \$6\.88 -> \$7\.01/)
  assert.doesNotMatch(r.messages()[0], /p5\.48xlarge/, 'the evidence stays in the pull request, not the phone message')

  const again = r.run('changed')
  assert.equal(again.status, 0, again.stderr)
  assert.equal(r.messages().length, 1, 'the same content on the same branch is not announced twice')
})

test('runner: main is never pushed to', () => {
  const r = rig()
  const before = r.origin('rev-parse', 'main')
  r.run('changed'); r.run('clean'); r.run('partial')
  assert.equal(r.origin('rev-parse', 'main'), before)
})

test('runner: rows that could not be read are reported, are not a clean pass, and propose nothing', () => {
  const r = rig()
  const res = r.run('partial')
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(branches(r.origin), ['agent-heartbeat', 'main'])
  assert.match(r.origin('show', 'agent-heartbeat:heartbeat.json'), /"read":29,"total":31,"unread":\["aws\/l4","aws\/h100"\]/)
  assert.equal(r.messages().length, 1)
  assert.match(r.messages()[0], /not a clean check/)
  assert.match(r.messages()[0], /not read aws\/l4: could not read b0\.p\.awsstatic\.com/)
})

test('runner: a crash of the refresh tells a person where it stopped and exits non-zero', () => {
  const r = rig()
  const res = r.run('crash')
  assert.equal(res.status, 1)
  assert.match(r.messages()[0], /FAILED at step 'refresh'/)
  assert.deepEqual(branches(r.origin), ['main'], 'a failed run pushes nothing, not even a heartbeat')
})

test('runner: a report of changes that did not happen is a failure, not a pull request', () => {
  const r = rig()
  const res = r.run('claimed-change-but-none')
  assert.equal(res.status, 1)
  assert.deepEqual(branches(r.origin), ['agent-heartbeat', 'main'])
  assert.match(r.messages()[0], /FAILED at step 'branch'/)
})

test('runner: with no way to tell anyone it refuses to run, and a dry run pushes and sends nothing', () => {
  const r = rig()
  const refused = r.run('changed', { GPU_RATES_NOTIFY: '' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /GPU_RATES_NOTIFY is not set/)
  assert.deepEqual(branches(r.origin), ['main'])

  const dry = r.run('changed', { GPU_RATES_PUSH: '0', GPU_RATES_NOTIFY: '' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /dry run, would send:\nGPU prices: 1 changed/)
  assert.deepEqual(branches(r.origin), ['main'])
  assert.equal(r.messages().length, 0)
})
