import { failHosts } from './dev'

const TIMEOUT_MS = 10_000

/** GET with a timeout: a hanging request must not freeze the board or the journey refresh. */
export async function httpGet(url: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  if (failHosts.size && failHosts.has(new URL(url).host)) throw new Error(`${new URL(url).host} failed (test)`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`)
    return res
  } finally {
    clearTimeout(timer)
  }
}

export async function getJson<T>(base: string, path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.append(k, String(v))
  return (await httpGet(`${base}${path}?${qs}`)).json() as Promise<T>
}
