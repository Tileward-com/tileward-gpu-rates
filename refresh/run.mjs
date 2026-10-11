#!/usr/bin/env node
/**
 * Re-read every provider's published price, compare with gpu-rates.json, and say whether a change is
 * needed. It PROPOSES; it never publishes. A person merging the pull request that carries the proposal
 * is the approval (README.md), and `validate.mjs` is still the gate on the file.
 *
 *   node refresh/run.mjs                          # print the verdict, change nothing
 *   node refresh/run.mjs --write                  # also write the proposed prices into gpu-rates.json
 *   node refresh/run.mjs --report r.json --heartbeat h.json
 *
 * Exit code: 0 nothing to change and every row was read; 10 a change is proposed; 11 nothing changed but
 * some rows could not be read; 12 both; 1 the run itself failed; 2 bad invocation. The two "could not read"
 * codes matter: a source that was not read is NOT a pass, and the quiet outcome must not look like one.
 *
 * WHAT IT EDITS. Only the digits of a price that changed. Every other byte of gpu-rates.json stays, so
 * "nothing moved" is byte-identical and a diff is only ever prices. Adding or removing a card, a provider
 * or a row is a person's decision, and a row that cannot be read keeps its old price.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USD_MAX, USD_MIN, validate } from '../validate.mjs'
import { Unreadable, formatUsd, makeGet, roundCents } from './lib.mjs'
import { SOURCES } from './sources.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const keyOf = (r) => `${r.provider}/${r.gpu}`

/** Put new prices into the file text, touching nothing but the number on each changed row's line. */
export function applyChanges(text, changes) {
  let out = text
  for (const c of changes) {
    const line = new RegExp(`(\\{"gpu": "${esc(c.gpu)}", "provider": "${esc(c.provider)}", "usd": )[0-9.]+(,)`)
    if (!line.test(out)) throw new Error(`cannot find the line for ${c.provider}/${c.gpu} in gpu-rates.json`)
    out = out.replace(line, (_, head, comma) => `${head}${formatUsd(c.usd)}${comma}`)
  }
  return out
}

/**
 * One full pass. `get(url)` returns text (see makeGet), so a test can answer from fixtures.
 * Returns { report, proposedText }.
 */
export async function refresh({ text, specs, get, now = () => new Date() }) {
  const current = JSON.parse(text)
  const rates = new Map(current.rates.map((r) => [keyOf(r), r]))
  const missing = specs.filter((s) => !rates.has(keyOf(s))).map(keyOf)
  if (missing.length) throw new Error(`refresh/rows.json looks up rows gpu-rates.json does not have: ${missing.join(', ')}`)
  const watched = new Set(specs.map(keyOf))
  const unwatched = [...rates.keys()].filter((k) => !watched.has(k))

  // Each distinct URL is fetched once; a failure to fetch fails every row that needed it, and no others.
  const docs = new Map()
  for (const s of specs) {
    const src = SOURCES[s.provider]
    if (!src) continue
    const url = src.url(s)
    if (docs.has(url)) continue
    try {
      const body = await get(url)
      docs.set(url, { doc: src.kind === 'json' ? JSON.parse(body) : body })
    } catch (e) {
      docs.set(url, { error: `could not read ${new URL(url).host}: ${e.message}` })
    }
  }

  const rows = specs.map((s) => {
    const base = { key: keyOf(s), gpu: s.gpu, provider: s.provider, old: rates.get(keyOf(s)).usd }
    const src = SOURCES[s.provider]
    if (!src) return { ...base, status: 'unread', reason: `no reader for provider ${s.provider}` }
    const url = src.url(s)
    const d = docs.get(url)
    if (d.error) return { ...base, status: 'unread', reason: d.error, url }
    try {
      const { price, evidence } = src.read(d.doc, s)
      const usd = roundCents(price / s.gpus)
      if (!(usd >= USD_MIN && usd <= USD_MAX)) throw new Unreadable(`read ${price} / ${s.gpus} = ${usd}, outside the plausible ${USD_MIN} to ${USD_MAX}`)
      return { ...base, status: usd === base.old ? 'same' : 'changed', new: usd, listed: price, divisor: s.gpus, evidence, url }
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e
      return { ...base, status: 'unread', reason: e.message, url }
    }
  })

  const changed = rows.filter((r) => r.status === 'changed')
  const unreadRows = rows.filter((r) => r.status === 'unread')
  const proposedText = applyChanges(text, changed.map((r) => ({ gpu: r.gpu, provider: r.provider, usd: r.new })))
  const problems = validate(JSON.parse(proposedText))
  if (problems.length) throw new Error(`the proposed file fails the gate (a bug in the refresh, not in a source): ${problems.join('; ')}`)

  const status = changed.length ? (unreadRows.length ? 'changed-partial' : 'changed') : unreadRows.length ? 'partial' : 'clean'
  const report = {
    schema: 1,
    checked: now().toISOString().replace(/\.\d+Z$/, 'Z'),
    status,
    counts: { total: rows.length, same: rows.length - changed.length - unreadRows.length, changed: changed.length, unread: unreadRows.length },
    unwatched,
    rows,
  }
  return { report, proposedText }
}

/** The small file the watchdog reads off the heartbeat branch. `unread` is what makes it honest. */
export function heartbeat(report) {
  return {
    checked: report.checked,
    changed: report.counts.changed > 0,
    read: report.counts.total - report.counts.unread,
    total: report.counts.total,
    unread: report.rows.filter((r) => r.status === 'unread').map((r) => r.key),
  }
}

const VERDICT = {
  clean: 'No change needed: every price was read and matches.',
  changed: 'Change proposed: at least one price differs from gpu-rates.json.',
  partial: 'No change found, but some rows could not be read, so this is NOT a clean pass.',
  'changed-partial': 'Change proposed, and some rows could not be read (they keep their old price).',
}
const EXIT = { clean: 0, changed: 10, partial: 11, 'changed-partial': 12 }

export function summarize(report) {
  const c = report.counts
  const lines = [`${VERDICT[report.status]}`, `${c.total} rows: ${c.same} same, ${c.changed} changed, ${c.unread} not read.`]
  for (const r of report.rows) {
    if (r.status === 'changed') lines.push(`  changed  ${r.key}: $${r.old.toFixed(2)} -> $${r.new.toFixed(2)}   [${r.evidence}]`)
  }
  for (const r of report.rows) if (r.status === 'unread') lines.push(`  not read ${r.key}: ${r.reason}`)
  if (report.unwatched.length) lines.push(`  not watched (in gpu-rates.json, no lookup in refresh/rows.json): ${report.unwatched.join(', ')}`)
  return lines.join('\n') + '\n'
}

async function cli(argv) {
  const opt = { rates: resolve(here, '../gpu-rates.json'), specs: resolve(here, 'rows.json'), write: false, report: null, heartbeat: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') opt.write = true
    else if (['--rates', '--specs', '--report', '--heartbeat'].includes(a) && i + 1 < argv.length) opt[a.slice(2)] = resolve(argv[++i])
    else {
      console.error('usage: node refresh/run.mjs [--write] [--rates gpu-rates.json] [--specs refresh/rows.json] [--report out.json] [--heartbeat out.json]')
      return 2
    }
  }
  const text = readFileSync(opt.rates, 'utf8')
  const { report, proposedText } = await refresh({ text, specs: JSON.parse(readFileSync(opt.specs, 'utf8')), get: makeGet() })
  process.stdout.write(summarize(report))
  if (opt.write && proposedText !== text) writeFileSync(opt.rates, proposedText)
  if (opt.report) writeFileSync(opt.report, JSON.stringify(report, null, 2) + '\n')
  if (opt.heartbeat) writeFileSync(opt.heartbeat, JSON.stringify(heartbeat(report)) + '\n')
  return EXIT[report.status]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`refresh failed: ${e.message}`)
      process.exit(1)
    },
  )
}
