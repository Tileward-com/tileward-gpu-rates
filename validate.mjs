#!/usr/bin/env node
/**
 * The gate for gpu-rates.json: what a change to it must satisfy before anyone should merge it, and
 * the summary of what a change does, which is what the person merging is approving.
 *
 *   node validate.mjs gpu-rates.json                  # exit 1 and list every problem, or print "ok"
 *   node validate.mjs --diff old.json new.json        # the change as a Markdown table, for a PR body
 *
 * WHY THIS FILE IS THE GATE. tileward.com serves this file from here, straight from `main`, so a
 * merge to main IS a publish: no build, no site deploy, no review of the site's own pipeline in
 * between. The site's Worker re-checks the shape before it serves a copy and falls back to the copy
 * bundled with the site when it fails, but that check is deliberately small. This one is the full one, and CI runs it on every pull request.
 *
 * WHAT IT DOES NOT DECIDE. Whether a price is RIGHT. It can say a number is plausible and that it
 * moved a lot; only the person merging can say it matches what the provider charges. That is why
 * `--diff` exists and why it marks large moves: the approval is a human looking at that table.
 *
 * No dependencies, so a CI job needs nothing but Node.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** A rate this far from the one before it is called out in the diff (a fraction, 0.25 is 25%). */
export const LARGE_MOVE = 0.25

/** The plausible range of a price per card-hour, in USD. A number outside it is a typo or a unit mistake. */
export const USD_MIN = 0.05
export const USD_MAX = 100

const ID = /^[a-z0-9][a-z0-9-]{0,23}$/
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !/[<>]/.test(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** Every problem with a parsed document, as sentences. Empty means it may be merged on shape. */
export function validate(d) {
  const out = []
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['the file is not a JSON object']
  const keys = Object.keys(d).sort().join(',')
  if (keys !== 'gpus,providers,rates,schema') out.push(`top-level keys must be exactly schema, gpus, providers, rates (found: ${Object.keys(d).join(', ')})`)
  if (d.schema !== 1) out.push(`schema must be 1 (found ${JSON.stringify(d.schema)}): the site reads version 1 only`)
  if (!Array.isArray(d.gpus) || !Array.isArray(d.providers) || !Array.isArray(d.rates)) return [...out, 'gpus, providers and rates must all be lists']

  const gpuIds = new Set(), provIds = new Set()
  for (const g of d.gpus) {
    if (!g || !ID.test(g.id || '') || !isStr(g.name, 1, 48) || !isNum(g.gb) || g.gb < 1 || g.gb > 1000) {
      out.push(`a card is malformed (id a-z0-9-, name up to 48 characters, gb 1 to 1000): ${JSON.stringify(g)}`)
      continue
    }
    if (gpuIds.has(g.id)) out.push(`card ${g.id} is listed twice`)
    gpuIds.add(g.id)
  }
  for (const p of d.providers) {
    if (!p || !ID.test(p.id || '') || !isStr(p.name, 1, 48)) {
      out.push(`a provider is malformed: ${JSON.stringify(p)}`)
      continue
    }
    if (provIds.has(p.id)) out.push(`provider ${p.id} is listed twice`)
    provIds.add(p.id)
  }

  const seen = new Set()
  for (const r of d.rates) {
    const at = `${r && r.provider}/${r && r.gpu}`
    if (!r || !gpuIds.has(r.gpu)) { out.push(`${at}: names a card the file does not list`); continue }
    if (!provIds.has(r.provider)) { out.push(`${at}: names a provider the file does not list`); continue }
    if (!isNum(r.usd) || r.usd < USD_MIN || r.usd > USD_MAX) out.push(`${at}: ${r.usd} is not a plausible price per card-hour (${USD_MIN} to ${USD_MAX})`)
    if (!isStr(r.basis, 3, 100)) out.push(`${at}: needs a "basis" of 3 to 100 characters saying which shape and region was priced`)
    const extra = Object.keys(r).filter((k) => !['gpu', 'provider', 'usd', 'basis'].includes(k))
    if (extra.length) out.push(`${at}: has fields the site does not read (${extra.join(', ')})`)
    if (seen.has(at)) out.push(`${at} is priced twice`)
    seen.add(at)
  }
  for (const id of gpuIds) if (!d.rates.some((r) => r.gpu === id)) out.push(`card ${id} has no price from any provider`)
  for (const id of provIds) if (!d.rates.some((r) => r.provider === id)) out.push(`provider ${id} has no price for any card`)
  for (const need of ['aws', 'gcp', 'azure']) if (!provIds.has(need)) out.push(`provider ${need} is missing`)
  if (provIds.size < 5) out.push('fewer than five providers: the calculator promises AWS, Google Cloud, Azure "and a few more"')

  return out
}

/** The difference between two documents, row by row. `pct` is a fraction of the old price. */
export function diffRates(a, b) {
  const key = (r) => `${r.provider}/${r.gpu}`
  const before = new Map((a.rates || []).map((r) => [key(r), r]))
  const after = new Map((b.rates || []).map((r) => [key(r), r]))
  const changes = []
  for (const [k, r] of after) {
    const old = before.get(k)
    if (!old) changes.push({ kind: 'added', key: k, provider: r.provider, gpu: r.gpu, from: null, to: r.usd, pct: null, basis: r.basis })
    else if (old.usd !== r.usd || old.basis !== r.basis) {
      changes.push({
        kind: 'changed', key: k, provider: r.provider, gpu: r.gpu, from: old.usd, to: r.usd,
        pct: old.usd ? (r.usd - old.usd) / old.usd : null, basis: r.basis, oldBasis: old.basis,
      })
    }
  }
  for (const [k, r] of before) {
    if (!after.has(k)) changes.push({ kind: 'removed', key: k, provider: r.provider, gpu: r.gpu, from: r.usd, to: null, pct: null, basis: r.basis })
  }
  const ids = (list) => new Set((list || []).map((x) => x.id))
  const gone = (x, y) => [...ids(x)].filter((i) => !ids(y).has(i))
  return {
    changes,
    cardsAdded: gone(b.gpus, a.gpus), cardsRemoved: gone(a.gpus, b.gpus),
    providersAdded: gone(b.providers, a.providers), providersRemoved: gone(a.providers, b.providers),
    large: changes.filter((c) => c.kind === 'changed' && c.pct !== null && Math.abs(c.pct) >= LARGE_MOVE),
  }
}

const usd = (n) => (n === null ? '–' : `$${n.toFixed(2)}`)

/** The change as a table a person can approve from a phone. */
export function markdownDiff(a, b) {
  const d = diffRates(a, b)
  const name = (list, id) => ((list || []).find((x) => x.id === id) || {}).name || id
  const lines = []
  if (!d.changes.length && !d.cardsAdded.length && !d.cardsRemoved.length && !d.providersAdded.length && !d.providersRemoved.length) {
    return 'No change.\n'
  }
  lines.push(`${d.changes.length} price(s) differ.`)
  if (d.large.length) lines.push(`**${d.large.length} moved by ${LARGE_MOVE * 100}% or more: check each against its source before merging.**`)
  if (d.cardsAdded.length) lines.push(`Cards added: ${d.cardsAdded.join(', ')}.`)
  if (d.cardsRemoved.length) lines.push(`Cards removed: ${d.cardsRemoved.join(', ')}.`)
  if (d.providersAdded.length) lines.push(`Providers added: ${d.providersAdded.join(', ')}.`)
  if (d.providersRemoved.length) lines.push(`Providers removed: ${d.providersRemoved.join(', ')}.`)
  lines.push('', '| Provider | Card | Was | Now | Change | Priced as |', '|---|---|---:|---:|---:|---|')
  for (const c of d.changes) {
    const pct = c.pct === null ? c.kind : `${c.pct >= 0 ? '+' : ''}${(c.pct * 100).toFixed(1)}%${Math.abs(c.pct) >= LARGE_MOVE ? ' ⚠' : ''}`
    lines.push(`| ${name(b.providers, c.provider)} | ${name(b.gpus, c.gpu)} | ${usd(c.from)} | ${usd(c.to)} | ${pct} | ${c.basis} |`)
  }
  return lines.join('\n') + '\n'
}

function cli(argv) {
  const read = (p) => readFileSync(p, 'utf8')
  if (argv[0] === '--diff') {
    if (argv.length !== 3) { console.error('usage: node validate.mjs --diff old.json new.json'); return 2 }
    process.stdout.write(markdownDiff(JSON.parse(read(argv[1])), JSON.parse(read(argv[2]))))
    return 0
  }
  if (argv.length !== 1) { console.error('usage: node validate.mjs gpu-rates.json'); return 2 }
  const text = read(argv[0])
  let d
  try { d = JSON.parse(text) } catch (e) { console.error(`not valid JSON: ${e.message}`); return 1 }
  const problems = validate(d)
  if (problems.length) {
    console.error(`${argv[0]}: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  - ${p}`)
    return 1
  }
  console.log(`ok: ${d.gpus.length} cards, ${d.providers.length} providers, ${d.rates.length} prices`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(cli(process.argv.slice(2)))
