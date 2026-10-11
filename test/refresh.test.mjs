/**
 * Tests for the refresh. The fixtures are real answers (trimmed, not edited): AWS's price file, Google's
 * page, Azure's API, Oracle's list, CoreWeave's page and Lambda's page, as read on 2026-10-10/11. A test that
 * only passes on good input proves nothing about a reader, so each reader also gets one test per check it
 * makes, with exactly that thing broken, expecting it to refuse (Unreadable) rather than read a wrong cell.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validate } from '../validate.mjs'
import { Unreadable, cellText, dollars, formatUsd, makeGet, roundCents } from '../refresh/lib.mjs'
import { prBody, prTitle } from '../refresh/pr-body.mjs'
import { applyChanges, heartbeat, refresh, summarize } from '../refresh/run.mjs'
import {
  AWS_URL, COREWEAVE_URL, GCP_URL, LAMBDA_URL, OCI_URL, azureUrl,
  lambdaSizes, lambdaTables, readAws, readAzure, readCoreweave, readGcp, readLambda, readOci,
} from '../refresh/sources.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(join(here, 'fixtures/refresh', name), 'utf8')
const RATES = readFileSync(join(here, '../gpu-rates.json'), 'utf8')
const SPECS = JSON.parse(readFileSync(join(here, '../refresh/rows.json'), 'utf8'))
const spec = (provider, gpu) => SPECS.find((s) => s.provider === provider && s.gpu === gpu)
const NOW = () => new Date('2026-10-12T07:00:00.123Z')

const bodies = () => ({
  [AWS_URL]: fx('aws.json'),
  [GCP_URL]: fx('gcp.html'),
  [OCI_URL]: fx('oci.json'),
  [COREWEAVE_URL]: fx('coreweave.html'),
  [LAMBDA_URL]: fx('lambda.html'),
  ...Object.fromEntries(SPECS.filter((s) => s.sku).map((s) => [azureUrl(s), fx(`azure-${s.region}-${s.sku}.json`)])),
})
const getFrom = (map) => async (url) => {
  if (!(url in map)) throw new Error(`no fixture for ${url}`)
  if (map[url] instanceof Error) throw map[url]
  return map[url]
}
const run = (map = bodies(), { specs = SPECS, text = RATES } = {}) => refresh({ text, specs, get: getFrom(map), now: NOW })
const refuses = (fn, pattern) => assert.throws(fn, (e) => e instanceof Unreadable && (!pattern || pattern.test(e.message)), `expected Unreadable ${pattern || ''}`)

const aws = () => JSON.parse(fx('aws.json'))
const azure = (s) => JSON.parse(fx(`azure-${s.region}-${s.sku}.json`))
const oci = () => JSON.parse(fx('oci.json'))
const awsRow = (doc, type) => Object.values(doc.regions['US East (N. Virginia)']).find((v) => v['Instance Type'] === type)

// ---------------------------------------------------------------------------------------- pieces

test('prices round to cents on the decimal value, half up', () => {
  assert.equal(roundCents(49.24 / 8), 6.16, '6.155 is 6.16, as CoreWeave shows it')
  assert.equal(roundCents(21.957642 / 8), 2.74)
  assert.equal(roundCents(0.8048), 0.8)
  assert.equal(roundCents(55.04 / 8), 6.88)
})

test('a price is written the way the file already writes it', () => {
  assert.equal(formatUsd(10), '10.0')
  assert.equal(formatUsd(3.4), '3.4')
  assert.equal(formatUsd(0.8), '0.8')
  assert.equal(formatUsd(11.06), '11.06')
})

test('text helpers read dollars and cells', () => {
  assert.equal(dollars('$1,234.50 / 1 hour'), 1234.5)
  assert.equal(dollars('N/A'), null)
  assert.equal(dollars('Contact sales'), null)
  assert.equal(cellText('<p>GPUs: 8</p>\n<p>vCPUs: 224</p>'), 'GPUs: 8 | vCPUs: 224')
  assert.equal(cellText('A&amp;B&nbsp;<b>c</b><br/>d'), 'A&B c d')
})

const reply = (status, body = '', headers = {}) => ({
  ok: status >= 200 && status < 300, status, text: async () => body,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
})

test('a 429 is retried after the time the server asks for', async () => {
  const slept = []
  const seq = [reply(429, '', { 'retry-after': '3' }), reply(200, 'ok')]
  const get = makeGet({ fetchImpl: async () => seq.shift(), sleep: async (ms) => slept.push(ms), now: () => 0, gapMs: {} })
  assert.equal(await get('https://example.test/x'), 'ok')
  assert.deepEqual(slept, [3000])
})

test('a 404 is not retried, and a persistent 500 gives up with its own message', async () => {
  let calls = 0
  const notFound = makeGet({ fetchImpl: async () => (calls++, reply(404)), sleep: async () => {}, gapMs: {} })
  await assert.rejects(notFound('https://example.test/x'), /HTTP 404/)
  assert.equal(calls, 1)
  calls = 0
  const broken = makeGet({ fetchImpl: async () => (calls++, reply(500)), sleep: async () => {}, gapMs: {}, tries: 3 })
  await assert.rejects(broken('https://example.test/x'), /HTTP 500/)
  assert.equal(calls, 3)
})

test('a network error is retried, and a host that rate-limits is called no faster than its gap', async () => {
  let clock = 1000
  const slept = []
  let calls = 0
  const get = makeGet({
    fetchImpl: async () => { calls++; if (calls === 1) throw new Error('socket hang up'); return reply(200, 'ok') },
    sleep: async (ms) => { slept.push(ms); clock += ms },
    now: () => clock,
    gapMs: { 'prices.azure.com': 1500 },
  })
  assert.equal(await get('https://prices.azure.com/api/retail/prices'), 'ok')
  assert.deepEqual(slept, [2000], 'one backoff after the failure; that 2s already satisfies the 1.5s gap')
  slept.length = 0
  assert.equal(await get('https://prices.azure.com/api/retail/prices?again'), 'ok')
  assert.deepEqual(slept, [1500], 'an immediate second call waits out the gap')
})

// ------------------------------------------------------------------------------ readers: good input

test('every reader returns the price on the page for the rows we watch', () => {
  assert.equal(readAws(aws(), spec('aws', 'h100')).price, 55.04)
  assert.equal(readAws(aws(), spec('aws', 'l4')).price, 0.8048)
  assert.equal(readGcp(fx('gcp.html'), spec('gcp', 'l4')).price, 0.706832276)
  assert.equal(readGcp(fx('gcp.html'), spec('gcp', 'h100')).price, 88.490000119)
  assert.equal(readGcp(fx('gcp.html'), spec('gcp', 'rtx-pro-6000')).price, 4.49993)
  assert.equal(readAzure(azure(spec('azure', 'a100-40')), spec('azure', 'a100-40')).price, 27.197)
  assert.equal(readAzure(azure(spec('azure', 'h200')), spec('azure', 'h200')).price, 84.8)
  assert.equal(readOci(oci(), spec('oci', 'h100')).price, 10)
  assert.equal(readOci(oci(), spec('oci', 'rtx-pro-6000')).price, 4.5)
  assert.equal(readCoreweave(fx('coreweave.html'), spec('coreweave', 'l40s')).price, 18)
  assert.equal(readCoreweave(fx('coreweave.html'), spec('coreweave', 'rtx-pro-6000')).price, 20)
  assert.equal(readLambda(fx('lambda.html'), spec('lambda', 'h100')).price, 3.99)
  assert.equal(readLambda(fx('lambda.html'), spec('lambda', 'a100-40')).price, 1.99)
  assert.equal(readLambda(fx('lambda.html'), spec('lambda', 'a100-80')).price, 2.79)
})

test('the evidence says what was read and where', () => {
  assert.match(readGcp(fx('gcp.html'), spec('gcp', 'l4')).evidence, /g2-standard-4 \| NVIDIA L4 \| GPUs: 1.*\$0\.706832276 \/ 1 hour \| Iowa \(us-central1\)/)
  assert.match(readAws(aws(), spec('aws', 'h100')).evidence, /p5\.48xlarge.*Linux: price 55\.04/)
  assert.match(readCoreweave(fx('coreweave.html'), spec('coreweave', 'h100')).evidence, /HGX H100.*GPU Count 8.*VRAM 80.*\$49\.24.*NORTH AMERICA/)
  assert.match(readLambda(fx('lambda.html'), spec('lambda', 'h100')).evidence, /8-GPU table/)
})

// ------------------------------------------------------------------- readers: each check can fail

test('AWS refuses what is not on-demand Linux USD with exactly one row', () => {
  const s = spec('aws', 'h100')
  let d = aws(); awsRow(d, 'p5.48xlarge')['Operating System'] = 'Windows'
  refuses(() => readAws(d, s), /found 0/)
  d = aws(); awsRow(d, 'p5.48xlarge')['Pre Installed S/W'] = 'SQL Std'
  refuses(() => readAws(d, s), /found 0/)
  d = aws(); d.regions['US East (N. Virginia)'].copy = { ...awsRow(d, 'p5.48xlarge') }
  refuses(() => readAws(d, s), /found 2/)
  d = aws(); d.manifest.currencyCode = 'EUR'
  refuses(() => readAws(d, s), /not in USD/)
  d = aws(); awsRow(d, 'p5.48xlarge').price = '0.0000000000'
  refuses(() => readAws(d, s), /no usable price/)
  d = aws(); d.regions = { 'EU (Ireland)': d.regions['US East (N. Virginia)'] }
  refuses(() => readAws(d, s), /no "US East/)
})

test('Google refuses another region, a different GPU count or card, a missing price and a renamed column', () => {
  const html = fx('gcp.html')
  const s = spec('gcp', 'l4')
  refuses(() => readGcp(html.replaceAll('Iowa (us-central1)', 'Frankfurt (europe-west3)'), s), /found 0/)
  refuses(() => readGcp(html, { ...s, gpus: 2 }), /not 2 GPU/)
  refuses(() => readGcp(html, { ...s, card: 'T4' }), /not T4/)
  refuses(() => readGcp(html.replace('$0.706832276 / 1 hour', 'N/A'), s), /no hourly price/)
  refuses(() => readGcp(html.replaceAll('Price (USD)', 'Cost'), s), /found 0/)
  refuses(() => readGcp(html + html, s), /found 2/)
  refuses(() => readGcp(html, { gpu: 'rtx-pro-6000', provider: 'gcp', machine: 'g4-standard-6', card: 'RTX PRO 6000', gpus: 1 }), /not 1 GPU/)
})

test('Azure refuses Windows, Spot and Low Priority rows, a second Linux row, a paged answer and another region', () => {
  const s = spec('azure', 'a100-80')
  const linux = (d) => d.Items.filter((i) => i.skuName === 'Standard_NC24ads_A100_v4' && /Linux/.test(i.productName))[0]
  let d = azure(s)
  assert.equal(readAzure(d, s).price, 3.673, 'the pay-as-you-go Linux row, not the Spot or Low Priority ones')
  d = azure(s); d.Items = d.Items.filter((i) => i !== linux(d))
  refuses(() => readAzure(d, s), /found 0/)
  d = azure(s); d.Items.push({ ...linux(d), meterId: 'another' })
  refuses(() => readAzure(d, s), /found 2/)
  d = azure(s); d.NextPageLink = 'https://prices.azure.com/api/retail/prices?$skip=100'
  refuses(() => readAzure(d, s), /paged/)
  refuses(() => readAzure(azure(s), { ...s, region: 'westus2' }), /found 0/)
  d = azure(s); linux(d).unitOfMeasure = '1 Month'
  refuses(() => readAzure(d, s), /found 0/)
})

test('Oracle refuses a part that changed its unit, its name, or its price list', () => {
  const s = spec('oci', 'h100')
  let d = oci(); d.items.find((i) => i.partNumber === 'B98415').metricName = 'Node Per Hour'
  refuses(() => readOci(d, s), /per "Node Per Hour"/)
  d = oci(); d.items.find((i) => i.partNumber === 'B98415').displayName = 'Compute - GPU - B200'
  refuses(() => readOci(d, s), /no longer H100/)
  d = oci(); d.items.find((i) => i.partNumber === 'B98415').currencyCodeLocalizations[0].prices.push({ model: 'PAY_AS_YOU_GO', value: 9 })
  refuses(() => readOci(d, s), /single USD/)
  refuses(() => readOci(oci(), { ...s, part: 'B000000' }), /no part B000000/)
})

test('CoreWeave refuses another region, a different count or memory, no price and a header that moved', () => {
  const html = fx('coreweave.html')
  const s = spec('coreweave', 'l40s')
  refuses(() => readCoreweave(html, { ...s, region: 'ASIA' }), /found 0/)
  refuses(() => readCoreweave(html, { ...s, vram: 40 }), /48 GB, not 40/)
  refuses(() => readCoreweave(html, { ...s, gpus: 4 }), /8 GPUs, not 4/)
  refuses(() => readCoreweave(html.replaceAll('$18.00', 'Contact sales'), s), /no listed on-demand price/)
  refuses(() => readCoreweave(html.replaceAll('<div>$18.00</div>', '<div>$19.00</div>'), s), /\$19\.00 but the row's own label says \$18\.00/)
  refuses(() => readCoreweave(html.replaceAll('On-Demand Price (Per Hour)', 'Price'), s), /no longer has/)
  refuses(() => readCoreweave(html + html, s), /found 2/)
  assert.equal(readCoreweave(html, { ...s, model: 'NVIDIA L40' }).price, 10, 'rows are matched by exact name: the L40 is its own row, never the L40S')
  refuses(() => readCoreweave(html, { ...s, model: 'NVIDIA L4' }), /found 0/)
})

test('Lambda refuses a page whose size tables cannot be told apart, and a plan that is not there', () => {
  const html = fx('lambda.html')
  assert.deepEqual(lambdaSizes(lambdaTables(html)), [8, 4, 2, 1])
  const s = spec('lambda', 'h100')
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((m) => m[0])
  refuses(() => readLambda(`<html>${tables.slice(0, 5).join('')}</html>`, s), /expected 4 on-demand/)
  refuses(() => readLambda(html.replaceAll('>104<', '>105<'), s), /scale 8:4:2:1/)
  refuses(() => readLambda(html.replace('$3.99', '—'), s), /no price/)
  refuses(() => readLambda(html, { ...s, vram: '40 GB' }), /found 0/)
  refuses(() => readLambda(html, { ...s, size: 3 }), /no 3-GPU table/)
})

// ------------------------------------------------------------------------------------ whole runs

test('on today\'s fixtures every row is read and none differs, and the file comes back byte for byte', async () => {
  const { report, proposedText } = await run()
  assert.equal(report.status, 'clean')
  assert.deepEqual(report.counts, { total: 31, same: 31, changed: 0, unread: 0 })
  assert.deepEqual(report.unwatched, [])
  assert.equal(proposedText, RATES)
  assert.equal(report.checked, '2026-10-12T07:00:00Z')
  assert.match(summarize(report), /No change needed/)
})

test('every priced row in gpu-rates.json has a lookup in refresh/rows.json, and each lookup has a row', async () => {
  const doc = JSON.parse(RATES)
  const rows = new Set(doc.rates.map((r) => `${r.provider}/${r.gpu}`))
  const looked = SPECS.map((s) => `${s.provider}/${s.gpu}`)
  assert.deepEqual([...rows].filter((k) => !looked.includes(k)), [], 'a priced row with no lookup is never refreshed: add it to refresh/rows.json')
  assert.deepEqual(looked.filter((k) => !rows.has(k)), [], 'a lookup for a row the file does not have')
  assert.equal(new Set(looked).size, looked.length, 'two lookups for one row')
})

test('a price that moved is found, written as digits only, and passes the gate', async () => {
  const map = bodies()
  const d = aws(); awsRow(d, 'p5.48xlarge').price = '88.0000000000' // 11.00 per GPU against 6.88
  map[AWS_URL] = JSON.stringify(d)
  const { report, proposedText } = await run(map)
  assert.equal(report.status, 'changed')
  const row = report.rows.find((r) => r.key === 'aws/h100')
  assert.deepEqual([row.status, row.old, row.new], ['changed', 6.88, 11])
  const was = RATES.split('\n'), now = proposedText.split('\n')
  const differing = was.map((l, i) => [l, now[i]]).filter(([a, b]) => a !== b)
  assert.equal(differing.length, 1, 'one line differs')
  assert.equal(differing[0][1], differing[0][0].replace('"usd": 6.88', '"usd": 11.0'))
  assert.deepEqual(validate(JSON.parse(proposedText)), [])
  assert.match(summarize(report), /changed {2}aws\/h100: \$6\.88 -> \$11\.00/)
})

test('a source that cannot be read leaves only its own rows unread, keeps their prices, and is not a clean pass', async () => {
  const map = bodies()
  map[AWS_URL] = new Error('connect ECONNREFUSED')
  const { report, proposedText } = await run(map)
  assert.equal(report.status, 'partial')
  assert.equal(report.counts.unread, 7)
  assert.equal(report.counts.same, 24)
  assert.match(report.rows.find((r) => r.key === 'aws/l4').reason, /could not read b0\.p\.awsstatic\.com: connect ECONNREFUSED/)
  assert.equal(proposedText, RATES, 'unread rows keep their old price')
  const hb = heartbeat(report)
  assert.equal(hb.changed, false)
  assert.equal(hb.read, 24)
  assert.equal(hb.unread.length, 7)
  assert.match(summarize(report), /NOT a clean pass/)
})

test('a page that changed shape fails its own rows, and a mixed run is both changed and partial', async () => {
  const map = bodies()
  map[GCP_URL] = fx('gcp.html').replaceAll('Iowa (us-central1)', 'Frankfurt (europe-west3)')
  const d = aws(); awsRow(d, 'p5.48xlarge').price = '88.0000000000'
  map[AWS_URL] = JSON.stringify(d)
  const { report } = await run(map)
  assert.equal(report.status, 'changed-partial')
  assert.deepEqual(report.rows.filter((r) => r.status === 'unread').map((r) => r.provider), ['gcp', 'gcp', 'gcp', 'gcp', 'gcp'])
  assert.equal(report.counts.changed, 1)
})

test('a number that cannot be a GPU-hour price is refused rather than proposed', async () => {
  const map = bodies()
  const d = aws(); awsRow(d, 'p5.48xlarge').price = '0.0100000000'
  map[AWS_URL] = JSON.stringify(d)
  const { report } = await run(map)
  assert.match(report.rows.find((r) => r.key === 'aws/h100').reason, /outside the plausible/)
  assert.equal(report.rows.find((r) => r.key === 'aws/h100').status, 'unread')
})

test('a lookup for a row the file lacks stops the run, and a row with no lookup is reported', async () => {
  await assert.rejects(run(bodies(), { specs: [...SPECS, { gpu: 'l4', provider: 'lambda', plan: 'x', vram: '24 GB', size: 1, gpus: 1 }] }), /does not have: lambda\/l4/)
  const { report } = await run(bodies(), { specs: SPECS.filter((s) => !(s.provider === 'aws' && s.gpu === 'l4')) })
  assert.deepEqual(report.unwatched, ['aws/l4'])
  assert.match(summarize(report), /not watched.*aws\/l4/)
})

test('applyChanges touches the number on the named line and nothing else, and refuses a row it cannot find', () => {
  const out = applyChanges(RATES, [{ gpu: 'h100', provider: 'oci', usd: 11 }, { gpu: 'l4', provider: 'aws', usd: 0.85 }])
  assert.match(out, /"gpu": "h100", "provider": "oci", "usd": 11\.0, "basis"/)
  assert.match(out, /"gpu": "l4", "provider": "aws", "usd": 0\.85, "basis"/)
  assert.equal(out.split('\n').filter((l, i) => l !== RATES.split('\n')[i]).length, 2)
  assert.throws(() => applyChanges(RATES, [{ gpu: 'l4', provider: 'lambda', usd: 1 }]), /cannot find the line for lambda\/l4/)
})

test('the heartbeat says whether everything was read, not just whether anything moved', async () => {
  const { report } = await run()
  assert.deepEqual(heartbeat(report), { checked: '2026-10-12T07:00:00Z', changed: false, read: 31, total: 31, unread: [] })
})

test('the command line refuses a bad invocation without touching the network', () => {
  const r = spawnSync(process.execPath, [join(here, '../refresh/run.mjs'), '--nonsense'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: node refresh\/run\.mjs/)
})

// ------------------------------------------------------------------------------------- PR text

test('the pull request text carries the diff, the reading for a large move, and what could not be read', async () => {
  const oldDoc = JSON.parse(RATES)
  const newDoc = JSON.parse(RATES)
  newDoc.rates.find((r) => r.provider === 'aws' && r.gpu === 'h100').usd = 11
  newDoc.rates.find((r) => r.provider === 'gcp' && r.gpu === 'l4').usd = 0.72
  const map = bodies()
  const d = aws(); awsRow(d, 'p5.48xlarge').price = '88.0000000000'
  map[AWS_URL] = JSON.stringify(d)
  map[GCP_URL] = new Error('timeout')
  const { report } = await run(map)

  assert.equal(prTitle(oldDoc, newDoc), 'GPU rates refresh: 2 changed')
  const body = prBody(oldDoc, newDoc, report)
  assert.match(body, /\| AWS \| NVIDIA H100 \| \$6\.88 \| \$11\.00 \| \+59\.9% ⚠ \|/)
  assert.match(body, /## Read at the source/)
  assert.match(body, /p5\.48xlarge.*price 88\.0/)
  assert.match(body, /## Not re-read/)
  assert.match(body, /Google Cloud \/ NVIDIA L4: could not read cloud\.google\.com: timeout/)
  assert.match(body, /Merge to publish/)
})

test('evidence is quoted only when the report\'s price is the one in the branch, and is flagged when absent', () => {
  const oldDoc = JSON.parse(RATES)
  const newDoc = JSON.parse(RATES)
  newDoc.rates.find((r) => r.provider === 'aws' && r.gpu === 'h100').usd = 11
  const stale = { rows: [{ key: 'aws/h100', status: 'changed', new: 9.5, evidence: 'THE WRONG READING', url: 'https://x' }] }
  assert.doesNotMatch(prBody(oldDoc, newDoc, stale), /THE WRONG READING/)
  assert.match(prBody(oldDoc, newDoc, stale), /No reading recorded for this price: check it against the provider/)
  assert.match(prBody(oldDoc, newDoc, null), /No reading recorded/)
})
