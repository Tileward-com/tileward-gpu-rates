/**
 * How each provider's published price is read. One entry per provider in SOURCES:
 *
 *   url(spec)        the page or API call that holds the price (rows sharing a URL share one fetch)
 *   kind             'json' or 'html': how the fetched text is parsed once
 *   read(doc, spec)  { price, evidence } for one row, or it throws Unreadable
 *
 * `price` is the list price of the unit the provider sells (an 8-GPU node, a GPU-hour); the caller
 * divides by `spec.gpus` and rounds. `evidence` is the text read, so a reviewer can check a large
 * move against it.
 *
 * THE RULE THAT MATTERS: a reader confirms it is looking at the right thing (the region, the GPU
 * count, the memory size, on-demand Linux and not Spot or Windows) and throws if it cannot. A page
 * that was redesigned must fail to read, not read the wrong cell. Each check below has a test that
 * breaks that one thing and expects the throw.
 */
import { cellText, decode, dollars, htmlTables, unread } from './lib.mjs'

export const AWS_URL =
  'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json'
export const GCP_URL = 'https://cloud.google.com/products/compute/pricing/accelerator-optimized'
export const OCI_URL = 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD'
export const COREWEAVE_URL = 'https://www.coreweave.com/pricing'
export const LAMBDA_URL = 'https://lambda.ai/pricing'

export function azureUrl(spec) {
  const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${spec.region}' and priceType eq 'Consumption' and armSkuName eq '${spec.sku}'`
  return `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`
}

// ------------------------------------------------------------------------------------------ AWS

const AWS_REGION = 'US East (N. Virginia)'

/** The AWS Pricing Calculator on-demand file: one on-demand Linux row per instance type. */
export function readAws(doc, spec) {
  if (!doc || !doc.manifest || doc.manifest.currencyCode !== 'USD') throw unread('the AWS price file is not in USD')
  const region = doc.regions && doc.regions[AWS_REGION]
  if (!region) throw unread(`the AWS price file has no "${AWS_REGION}" section`)
  const hits = Object.values(region).filter(
    (v) =>
      v['Instance Type'] === spec.instance &&
      v['Operating System'] === 'Linux' &&
      v['Pre Installed S/W'] === 'NA' &&
      v['License Model'] === 'No License required',
  )
  if (hits.length !== 1) throw unread(`expected one on-demand Linux row for ${spec.instance}, found ${hits.length}`)
  const price = Number(hits[0].price)
  if (!(price > 0)) throw unread(`${spec.instance} has no usable price (${JSON.stringify(hits[0].price)})`)
  return {
    price,
    evidence: `${spec.instance}, ${AWS_REGION}, Linux: price ${hits[0].price} (file published ${doc.manifest.hawkFilePublicationDate})`,
  }
}

// ------------------------------------------------------------------------------------ Google Cloud

const GCP_REGION = 'Iowa (us-central1)'

/** The page's tables, each with the region its selector shows right after it. */
export function gcpTables(html) {
  const tables = htmlTables(html)
  return tables.map((t, i) => {
    const stop = Math.min(i + 1 < tables.length ? tables[i + 1].start : html.length, t.end + 30000)
    const label = /jsname="Fb0Bif">([^<]*)</.exec(html.slice(t.end, stop))
    return { ...t, region: label ? decode(label[1]).trim() : null }
  })
}

export function readGcp(html, spec) {
  const hits = []
  for (const t of gcpTables(html)) {
    if (t.region !== GCP_REGION) continue
    const header = t.rows.find((r) => r[0] === 'Machine type')
    const col = header ? header.findIndex((c) => c.startsWith('Price (USD)')) : -1
    if (col < 0) continue
    for (const r of t.rows) if (r[0] === spec.machine) hits.push({ r, col })
  }
  if (hits.length !== 1) throw unread(`expected one ${spec.machine} row in the ${GCP_REGION} tables, found ${hits.length}`)
  const { r, col } = hits[0]
  if (!new RegExp(spec.card, 'i').test(r[1] || '')) throw unread(`${spec.machine} is listed as "${r[1]}", not ${spec.card}`)
  const count = /GPUs: (\d+)(?![\d/])/.exec(r[2] || '')
  if (!count || Number(count[1]) !== spec.gpus) throw unread(`${spec.machine} lists "${r[2]}", not ${spec.gpus} GPU(s)`)
  const price = /^\$([0-9]+(?:\.[0-9]+)?) \/ 1 hour$/.exec(r[col] || '')
  if (!price) throw unread(`${spec.machine} has no hourly price in the Price (USD) column (found "${r[col]}")`)
  return { price: Number(price[1]), evidence: `${spec.machine} | ${r[1]} | ${r[2]} | Price (USD): ${r[col]} | ${GCP_REGION}` }
}

// ----------------------------------------------------------------------------------------- Azure

/** The Retail Prices API answer for one size in one region: keep Linux, pay-as-you-go, one hour. */
export function readAzure(doc, spec) {
  if (!doc || !Array.isArray(doc.Items)) throw unread('the Azure answer has no Items list')
  if (doc.NextPageLink) throw unread('the Azure answer is paged: more rows than were read')
  const rows = doc.Items.filter(
    (i) =>
      i.serviceName === 'Virtual Machines' &&
      i.type === 'Consumption' &&
      i.currencyCode === 'USD' &&
      i.armRegionName === spec.region &&
      i.armSkuName === spec.sku &&
      i.unitOfMeasure === '1 Hour' &&
      !/Windows/i.test(i.productName || '') &&
      !/Spot|Low Priority/i.test(`${i.skuName} ${i.meterName}`),
  )
  if (rows.length !== 1) throw unread(`expected one Linux pay-as-you-go row for ${spec.sku} in ${spec.region}, found ${rows.length}`)
  const price = rows[0].retailPrice
  if (!(price > 0)) throw unread(`${spec.sku} has no usable price (${JSON.stringify(price)})`)
  return { price, evidence: `${rows[0].skuName} | ${rows[0].productName} | ${spec.region} | retailPrice ${price} per ${rows[0].unitOfMeasure}` }
}

// ---------------------------------------------------------------------------------------- Oracle

/** Oracle's public price list: a per-GPU-hour price by part number. */
export function readOci(doc, spec) {
  const item = doc && Array.isArray(doc.items) ? doc.items.find((i) => i.partNumber === spec.part) : null
  if (!item) throw unread(`Oracle's price list has no part ${spec.part}`)
  if (item.metricName !== 'GPU Per Hour') throw unread(`part ${spec.part} is priced per "${item.metricName}", not per GPU hour`)
  if (!String(item.displayName || '').toLowerCase().includes(spec.token.toLowerCase())) {
    throw unread(`part ${spec.part} is now called "${item.displayName}", no longer ${spec.token}`)
  }
  const loc = (item.currencyCodeLocalizations || []).find((c) => c.currencyCode === 'USD')
  const prices = loc ? loc.prices.filter((p) => p.model === 'PAY_AS_YOU_GO') : []
  if (prices.length !== 1 || !(prices[0].value > 0)) throw unread(`part ${spec.part} has no single USD pay-as-you-go price`)
  return { price: prices[0].value, evidence: `${spec.part} '${item.displayName}' / ${item.metricName} / PAY_AS_YOU_GO ${prices[0].value}` }
}

// -------------------------------------------------------------------------------------- CoreWeave

/** Every row of the pricing page's tables, with the region heading it sits under and its column names. */
export function coreweaveRows(html) {
  const marks = [...html.matchAll(/<div role="listitem" class="table-row-v2([^"]*)">/g)]
  const eyebrows = [...html.matchAll(/<strong class="eyebrow">([^<]*)<\/strong>/g)].map((m) => ({ pos: m.index, label: cellText(m[1]).toUpperCase() }))
  const modelHeads = [...html.matchAll(/<div class="table-header-text">GPU Model<\/div>/g)].map((m) => m.index)
  return marks.map((m, i) => {
    const block = html.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : m.index + 8000)
    const eyebrow = [...eyebrows].reverse().find((e) => e.pos < m.index)
    const head = [...modelHeads].reverse().find((p) => p < m.index)
    const headers =
      head === undefined
        ? []
        : [...html.slice(head, head + 3000).matchAll(/<div class="table-header-text">([\s\S]*?)<\/div>/g)].slice(0, 9).map((h) => cellText(h[1]))
    const name = /<h3[^>]*class="table-model-name"[^>]*>([\s\S]*?)<\/h3>/.exec(block)
    const od = /<span class="instance-price">On-Demand Price: <span class="item-value">([^<]*)<\/span>/.exec(block)
    return {
      region: eyebrow ? eyebrow.label : null,
      isGpu: /gpu-pricing/.test(m[1]),
      name: name ? cellText(name[1]) : '',
      cells: [...block.matchAll(/<div class="table-v2-cell(?: [^"]*)?">\s*<div>([^<]*)<\/div>/g)].map((c) => cellText(c[1])),
      od: od ? od[1].trim() : null,
      headers,
    }
  })
}

export function readCoreweave(html, spec) {
  const want = `REGION: ${spec.region}`
  const hits = coreweaveRows(html).filter((r) => r.isGpu && r.region === want && r.name === spec.model)
  if (hits.length !== 1) throw unread(`expected one "${spec.model}" row under ${want}, found ${hits.length}`)
  const row = hits[0]
  const col = (title) => row.headers.indexOf(title) - 1 // headers[0] is the model-name column
  const [ci, vi, pi] = [col('GPU Count'), col('VRAM (GB)'), col('On-Demand Price (Per Hour)')]
  if (ci < 0 || vi < 0 || pi < 0) throw unread('the CoreWeave table no longer has GPU Count, VRAM and On-Demand Price columns')
  if (parseInt(row.cells[ci], 10) !== spec.gpus) throw unread(`${spec.model} lists ${row.cells[ci]} GPUs, not ${spec.gpus}`)
  if (parseInt(row.cells[vi], 10) !== spec.vram) throw unread(`${spec.model} lists ${row.cells[vi]} GB, not ${spec.vram}`)
  const price = dollars(row.cells[pi] || '')
  if (price === null) throw unread(`${spec.model} has no listed on-demand price (found "${row.cells[pi]}")`)
  if (row.od !== null && row.od !== row.cells[pi]) throw unread(`${spec.model}: the table says ${row.cells[pi]} but the row's own label says ${row.od}`)
  return { price, evidence: `${row.name} | GPU Count ${row.cells[ci]} | VRAM ${row.cells[vi]} GB | On-Demand Price (Per Hour) ${row.cells[pi]} | ${want}` }
}

// ----------------------------------------------------------------------------------------- Lambda

/** The page does not label its on-demand tables with a GPU count; they are 8x, 4x, 2x, 1x in order. */
const LAMBDA_SIZES = [8, 4, 2, 1]
const LAMBDA_REFERENCES = [
  ['NVIDIA H100 SXM', '80 GB'],
  ['NVIDIA B200 SXM6', '180 GB'],
]

export function lambdaTables(html) {
  return htmlTables(html).filter((t) => t.rows[0] && ['PRICE/GPU/HR*', 'VRAM/GPU', 'vCPUs'].every((h) => t.rows[0].includes(h)))
}

/** Prove the order instead of assuming it: a plan's vCPUs must scale exactly 8:4:2:1 across the tables. */
export function lambdaSizes(tables) {
  if (tables.length !== LAMBDA_SIZES.length) throw unread(`expected ${LAMBDA_SIZES.length} on-demand size tables on Lambda's page, found ${tables.length}`)
  for (const [plan, vram] of LAMBDA_REFERENCES) {
    const v = tables.map((t) => {
      const row = t.rows.find((r) => r[0] === plan && r[1] === vram)
      return row ? Number(row[2]) : NaN
    })
    const unit = v[v.length - 1]
    if (unit > 0 && v.every((n, i) => n === unit * LAMBDA_SIZES[i])) return LAMBDA_SIZES
  }
  throw unread("Lambda's size tables no longer scale 8:4:2:1 in vCPUs for a reference plan, so their GPU counts cannot be told apart")
}

export function readLambda(html, spec) {
  const tables = lambdaTables(html)
  const table = tables[lambdaSizes(tables).indexOf(spec.size)]
  if (!table) throw unread(`no ${spec.size}-GPU table on Lambda's page`)
  const rows = table.rows.filter((r) => r[0] === spec.plan && r[1] === spec.vram)
  if (rows.length !== 1) throw unread(`expected one "${spec.plan}" ${spec.vram} row in the ${spec.size}-GPU table, found ${rows.length}`)
  const price = dollars(rows[0][table.rows[0].indexOf('PRICE/GPU/HR*')] || '')
  if (price === null) throw unread(`${spec.plan} ${spec.vram} has no price in the ${spec.size}-GPU table`)
  return { price, evidence: `${spec.plan} | ${spec.vram} | ${rows[0][2]} vCPUs | PRICE/GPU/HR* $${price} | ${spec.size}-GPU table` }
}

// --------------------------------------------------------------------------------------- registry

export const SOURCES = {
  aws: { url: () => AWS_URL, kind: 'json', read: readAws },
  gcp: { url: () => GCP_URL, kind: 'html', read: readGcp },
  azure: { url: azureUrl, kind: 'json', read: readAzure },
  oci: { url: () => OCI_URL, kind: 'json', read: readOci },
  coreweave: { url: () => COREWEAVE_URL, kind: 'html', read: readCoreweave },
  lambda: { url: () => LAMBDA_URL, kind: 'html', read: readLambda },
}
