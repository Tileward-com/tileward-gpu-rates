/**
 * Small shared pieces for the refresh: the "could not read it" error, price rounding, a tolerant
 * HTML table reader, and one HTTP getter that paces and retries. No dependencies.
 */

/** A source did not show what we expected. The row keeps its old price; it is never guessed. */
export class Unreadable extends Error {
  constructor(message) {
    super(message)
    this.name = 'Unreadable'
  }
}
export const unread = (message) => new Unreadable(message)

/** Round to cents, half up, on the DECIMAL value: 49.24 / 8 = 6.155 is 6.16, not the float's 6.15. */
export function roundCents(x) {
  return Math.round(Number((x * 100).toPrecision(12))) / 100
}

/** How a price is written in gpu-rates.json: 10 is `10.0`, 3.4 is `3.4` (the file's existing style). */
export function formatUsd(v) {
  return Number.isInteger(v) ? v.toFixed(1) : String(v)
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' }
export const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENTITIES[m])

/** The visible text of one cell: paragraphs joined with " | ", tags dropped, spaces collapsed. */
export function cellText(html) {
  return decode(html.replace(/<\/p>\s*<p\b[^>]*>/gi, ' | ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every <table> in a page as { start, end, rows: [[cell text]] }. Tables here are not nested. */
export function htmlTables(html) {
  const out = []
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    const rows = [...t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/g)].map((c) => cellText(c[2])),
    )
    out.push({ start: t.index, end: t.index + t[0].length, rows })
  }
  return out
}

/** "$1,234.56 / hour" -> 1234.56; anything that does not start with a dollar amount -> null. */
export function dollars(s) {
  const m = /^\$([0-9][0-9,]*(?:\.[0-9]+)?)(?![0-9])/.exec(String(s).trim())
  return m ? Number(m[1].replace(/,/g, '')) : null
}

export const USER_AGENT = 'tileward-gpu-rates-refresh/1 (+https://github.com/Tileward-com/tileward-gpu-rates)'

/**
 * One GET that returns the body text. Retries a timeout, a 429 and a 5xx (honouring Retry-After) and
 * spaces calls to a host that rate-limits (Azure's price API answers 429 to a quick burst). `fetchImpl`
 * and `sleep` are injectable so the retry rules are tested without a network.
 */
export function makeGet({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  timeoutMs = 90_000,
  tries = 4,
  gapMs = { 'prices.azure.com': 1500 },
} = {}) {
  const last = new Map()
  return async function get(url) {
    const host = new URL(url).host
    let failure
    for (let attempt = 1; attempt <= tries; attempt++) {
      const since = last.has(host) ? now() - last.get(host) : Infinity
      const wait = (gapMs[host] || 0) - since
      if (wait > 0) await sleep(wait)
      last.set(host, now())
      let retryAfterMs = 0
      try {
        const res = await fetchImpl(url, {
          headers: { 'user-agent': USER_AGENT, accept: '*/*' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        })
        if (res.ok) return await res.text()
        failure = new Error(`HTTP ${res.status} from ${host}`)
        if (res.status !== 429 && res.status < 500) throw failure
        const ra = Number(res.headers.get('retry-after'))
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000
      } catch (e) {
        failure = e
        if (/^HTTP 4\d\d /.test(e.message) && !/^HTTP 429 /.test(e.message)) throw e
      }
      if (attempt < tries) await sleep(Math.min(retryAfterMs || 2000 * 2 ** (attempt - 1), 60_000))
    }
    throw failure
  }
}
