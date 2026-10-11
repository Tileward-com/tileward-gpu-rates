#!/usr/bin/env node
/**
 * The title and body of the pull request that carries a refresh, built from main's file, the branch's
 * file and (optionally) the run's report. The workflow that opens the pull request calls this.
 *
 *   node refresh/pr-body.mjs --old main.json --new branch.json [--report report.json] --title
 *   node refresh/pr-body.mjs --old main.json --new branch.json [--report report.json] --body
 *
 * The table is validate.mjs's own `--diff`, computed here from the two files, so the approval is made
 * against a diff nobody typed. The report only ADDS the text read at the source for large moves and the
 * list of rows that could not be read; it is used for a row only when its price is the one in the branch.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LARGE_MOVE, diffRates, markdownDiff } from '../validate.mjs'

const usd = (n) => `$${n.toFixed(2)}`
const name = (list, id) => ((list || []).find((x) => x.id === id) || {}).name || id

export function prTitle(oldDoc, newDoc) {
  return `GPU rates refresh: ${diffRates(oldDoc, newDoc).changes.length} changed`
}

export function prBody(oldDoc, newDoc, report) {
  const d = diffRates(oldDoc, newDoc)
  const out = [markdownDiff(oldDoc, newDoc).trimEnd()]
  const byKey = new Map(((report && report.rows) || []).map((r) => [r.key, r]))
  const newPrice = new Map(newDoc.rates.map((r) => [`${r.provider}/${r.gpu}`, r.usd]))

  if (d.large.length) {
    out.push('', `## Read at the source (moves of ${LARGE_MOVE * 100}% or more)`)
    for (const c of d.large) {
      const row = byKey.get(c.key)
      const label = `${name(newDoc.providers, c.provider)} / ${name(newDoc.gpus, c.gpu)}`
      out.push(`- **${label}**: ${usd(c.from)} -> ${usd(c.to)}`)
      if (row && row.status === 'changed' && row.new === newPrice.get(c.key)) out.push(`  - ${row.evidence}`, `  - ${row.url}`)
      else out.push('  - No reading recorded for this price: check it against the provider before merging.')
    }
  }

  const unread = [...byKey.values()].filter((r) => r.status === 'unread')
  if (unread.length) {
    out.push('', '## Not re-read (these keep their previous price)')
    for (const r of unread) out.push(`- ${name(newDoc.providers, r.provider)} / ${name(newDoc.gpus, r.gpu)}: ${r.reason}`)
  }

  out.push('', 'Merge to publish (live on tileward.com in about ten minutes). Close to reject.')
  return out.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2)
  const opt = (flag) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : null)
  if (!opt('--old') || !opt('--new') || !(a.includes('--title') || a.includes('--body'))) {
    console.error('usage: node refresh/pr-body.mjs --old main.json --new branch.json [--report report.json] --title|--body')
    process.exit(2)
  }
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
  const oldDoc = read(opt('--old'))
  const newDoc = read(opt('--new'))
  let report = null
  if (opt('--report')) {
    try { report = read(opt('--report')) } catch { /* a missing or unreadable report only removes the evidence lines */ }
  }
  process.stdout.write(a.includes('--title') ? prTitle(oldDoc, newDoc) + '\n' : prBody(oldDoc, newDoc, report))
}
