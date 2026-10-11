/**
 * The gate for gpu-rates.json, and the diff a person approves a change from.
 *
 * The file is served by tileward.com straight from main, so every rule here is one a bad merge
 * would otherwise carry onto the site. Each test below breaks ONE thing in a copy of the real file
 * and expects the gate to name it: a gate that is green on the real file proves nothing until it
 * has been seen to go red.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { validate, diffRates, markdownDiff, LARGE_MOVE } from '../validate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, 'gpu-rates.json'), 'utf8')
const real = () => JSON.parse(text)

describe('the real file', () => {
  test('passes', () => assert.deepEqual(validate(real()), []))

  test('passes through the command line, which is what CI runs', () => {
    const out = execFileSync('node', [join(root, 'validate.mjs'), join(root, 'gpu-rates.json')], { encoding: 'utf8' })
    assert.match(out, /^ok: \d+ cards, \d+ providers, \d+ prices/)
  })
})

describe('the gate refuses what the site must never serve', () => {
  const broken = (mutate) => { const d = real(); mutate(d); return validate(d) }
  const names = (problems, needle) => problems.some((p) => p.includes(needle))

  test('a price that is not a plausible number', () => {
    for (const bad of [0, -1, 1000, 'cheap', null, NaN]) {
      assert.ok(names(broken((d) => { d.rates[0].usd = bad }), 'plausible'), `${bad} was accepted`)
    }
  })

  test('a rate for a card or provider the file does not list', () => {
    assert.ok(names(broken((d) => { d.rates[0].gpu = 'nope' }), 'card the file does not list'))
    assert.ok(names(broken((d) => { d.rates[0].provider = 'nope' }), 'provider the file does not list'))
  })

  test('a price with no statement of what was priced', () => {
    assert.ok(names(broken((d) => { d.rates[0].basis = '' }), 'basis'))
    assert.ok(names(broken((d) => { delete d.rates[0].basis }), 'basis'))
  })

  test('a price listed twice, a card listed twice', () => {
    assert.ok(names(broken((d) => { d.rates.push({ ...d.rates[0] }) }), 'priced twice'))
    assert.ok(names(broken((d) => { d.gpus.push({ ...d.gpus[0] }) }), 'listed twice'))
  })

  test('a field the site does not read, which is how a note or a link would get onto the site', () => {
    assert.ok(names(broken((d) => { d.rates[0].source = 'https://example.com' }), 'fields the site does not read'))
    assert.ok(names(broken((d) => { d.banner = 'hi' }), 'top-level keys'))
  })

  test('markup in a name', () => {
    assert.ok(names(broken((d) => { d.gpus[0].name = '<img src=x>' }), 'malformed'))
  })

  test('a card nobody sells and a provider that sells nothing', () => {
    assert.ok(names(broken((d) => { d.gpus.push({ id: 'zz', name: 'Nothing', gb: 8 }) }), 'no price from any provider'))
    assert.ok(names(broken((d) => { d.providers.push({ id: 'zz', name: 'Nobody' }) }), 'no price for any card'))
  })

  test('one of the three providers the calculator promises, or fewer than five', () => {
    assert.ok(names(broken((d) => { d.providers = d.providers.filter((p) => p.id !== 'aws'); d.rates = d.rates.filter((r) => r.provider !== 'aws') }), 'aws is missing'))
    assert.ok(names(broken((d) => {
      const keep = new Set(['aws', 'gcp', 'azure'])
      d.providers = d.providers.filter((p) => keep.has(p.id)); d.rates = d.rates.filter((r) => keep.has(r.provider))
    }), 'fewer than five'))
  })

  test('a different schema, which the site would refuse to read', () => {
    assert.ok(names(broken((d) => { d.schema = 2 }), 'schema must be 1'))
  })

  test('something that is not a document at all', () => {
    assert.deepEqual(validate(null), ['the file is not a JSON object'])
    assert.deepEqual(validate([]), ['the file is not a JSON object'])
  })
})

describe('the diff a person approves a change from', () => {
  const change = (fn) => { const d = real(); fn(d); return d }

  test('an identical file is no change', () => {
    assert.equal(markdownDiff(real(), real()), 'No change.\n')
    assert.deepEqual(diffRates(real(), real()).changes, [])
  })

  test('a moved price is reported with what it was, what it is, and by how much', () => {
    const next = change((d) => { d.rates[0].usd = Math.round(d.rates[0].usd * 1.1 * 100) / 100 })
    const { changes } = diffRates(real(), next)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].kind, 'changed')
    assert.equal(changes[0].from, real().rates[0].usd)
    assert.ok(Math.abs(changes[0].pct - 0.1) < 0.01)
    assert.match(markdownDiff(real(), next), /\+10\.\d%/)
  })

  test('a large move is called out in words and in the row', () => {
    const next = change((d) => { d.rates[0].usd = Math.round(d.rates[0].usd * (1 + LARGE_MOVE + 0.1) * 100) / 100 })
    const md = markdownDiff(real(), next)
    assert.match(md, /moved by 25% or more/)
    assert.match(md, /⚠/)
    assert.equal(diffRates(real(), next).large.length, 1)
  })

  test('a small move is not called out as large', () => {
    const next = change((d) => { d.rates[0].usd = Math.round(d.rates[0].usd * 1.02 * 100) / 100 })
    assert.equal(diffRates(real(), next).large.length, 0)
    assert.ok(!markdownDiff(real(), next).includes('⚠'))
  })

  test('a price added and a price removed are both shown', () => {
    const removed = change((d) => { d.rates.pop() })
    assert.equal(diffRates(real(), removed).changes[0].kind, 'removed')
    assert.equal(diffRates(removed, real()).changes[0].kind, 'added')
  })

  test('a card or a provider that comes or goes is said in a sentence, not left to the table', () => {
    const fewer = change((d) => { d.gpus = d.gpus.filter((g) => g.id !== 'l4'); d.rates = d.rates.filter((r) => r.gpu !== 'l4') })
    assert.deepEqual(diffRates(real(), fewer).cardsRemoved, ['l4'])
    assert.match(markdownDiff(real(), fewer), /Cards removed: l4\./)
  })

  test('a change of what was priced (the shape or region) with the same number is still a change', () => {
    const next = change((d) => { d.rates[0].basis = d.rates[0].basis + ', other region' })
    assert.equal(diffRates(real(), next).changes.length, 1)
  })

  test('the command line prints the same table', () => {
    const next = change((d) => { d.rates[0].usd = Math.round(d.rates[0].usd * 1.5 * 100) / 100 })
    const p = join(root, 'test', '.next.json')   // beside the test so the path is predictable; removed below
    writeFileSync(p, JSON.stringify(next))
    try {
      const out = execFileSync('node', [join(root, 'validate.mjs'), '--diff', join(root, 'gpu-rates.json'), p], { encoding: 'utf8' })
      assert.match(out, /1 price\(s\) differ\./)
      assert.match(out, /\| Provider \| Card \| Was \| Now \| Change \| Priced as \|/)
    } finally {
      rmSync(p, { force: true })
    }
  })
})

describe('the command line', () => {
  test('exits 1 and lists every problem for a bad file, and 2 for a bad invocation', () => {
    const r = spawnSync('node', [join(root, 'validate.mjs'), join(root, 'package.json')], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    const usage = spawnSync('node', [join(root, 'validate.mjs')], { encoding: 'utf8' })
    assert.equal(usage.status, 2)
  })
})
