// Phone-side settings page inside the Even App WebView: settings and preset targets.

import type { Location } from './api'
import { loadSettings, loadTargets, saveSettings, saveTargets, type Settings, type Target } from './bridge'
import { DEFAULT_NETWORK, NETWORKS, getNetwork } from './networks'
import { CREDITS } from './credits'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function locationQuery(l: Location): string | null {
  if (l.id) return l.id
  const c = l.coordinate
  return c && c.x != null && c.y != null ? `${c.x},${c.y}` : null
}

const kindLabel = (l: Location) =>
  l.id ? 'Stop' : l.icon === 'poi' ? 'Place' : 'Address'

export async function mountCompanion(
  onChange: (targets: Target[]) => void,
  onSettings: (settings: Settings) => void = () => {},
): Promise<void> {
  let targets = await loadTargets()
  let settings = await loadSettings()
  let picked: Location | null = null
  let searchSeq = 0
  let debounce: ReturnType<typeof setTimeout> | undefined

  const list = $<HTMLUListElement>('#targets')
  const form = $<HTMLFormElement>('#add-form')
  const label = $<HTMLInputElement>('#label')
  const search = $<HTMLInputElement>('#search')
  const results = $<HTMLUListElement>('#results')
  const pickedEl = $<HTMLDivElement>('#picked')
  const saveBtn = $<HTMLButtonElement>('#save')
  const networkSel = $<HTMLSelectElement>('#network')
  const mapToggle = $<HTMLInputElement>('#map')
  const searchNetwork = $<HTMLSelectElement>('#search-network')

  const options = (withAuto: boolean) =>
    [
      ...(withAuto ? [`<option value="auto">Automatic (by location)</option>`] : []),
      ...NETWORKS.map((n) => `<option value="${n.id}">${esc(n.name)} · ${esc(n.source)}</option>`),
    ].join('')
  networkSel.innerHTML = options(true)
  networkSel.value = settings.network
  mapToggle.checked = settings.map
  searchNetwork.innerHTML = options(false)
  searchNetwork.value = settings.network === 'auto' ? DEFAULT_NETWORK : settings.network

  const persistSettings = async () => {
    settings = { network: networkSel.value, map: mapToggle.checked }
    await saveSettings(settings)
    onSettings(settings)
  }
  networkSel.addEventListener('change', () => {
    if (networkSel.value !== 'auto') searchNetwork.value = networkSel.value
    void persistSettings()
  })
  mapToggle.addEventListener('change', () => void persistSettings())

  const persist = async () => {
    await saveTargets(targets)
    onChange(targets)
    renderTargets()
  }

  const renderTargets = () => {
    if (targets.length === 0) {
      list.innerHTML = '<li class="empty">No targets yet. Add home, work or any stop below.</li>'
      return
    }
    list.innerHTML = targets
      .map(
        (t, i) => `
        <li class="row">
          <div class="row-text">
            <span class="row-title">${esc(t.label)}</span>
            <span class="row-sub">${esc(t.place)} · ${esc(getNetwork(t.network).name)}</span>
          </div>
          <div class="row-actions">
            <button class="icon" data-act="up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon" data-act="down" data-i="${i}" aria-label="Move down" ${i === targets.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon danger" data-act="del" data-i="${i}" aria-label="Delete">✕</button>
          </div>
        </li>`,
      )
      .join('')
  }

  list.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
    if (!btn) return
    const i = Number(btn.dataset.i)
    const act = btn.dataset.act
    if (act === 'del') targets.splice(i, 1)
    if (act === 'up' && i > 0) [targets[i - 1], targets[i]] = [targets[i], targets[i - 1]]
    if (act === 'down' && i < targets.length - 1) [targets[i + 1], targets[i]] = [targets[i], targets[i + 1]]
    void persist()
  })

  const updateSave = () => {
    saveBtn.disabled = !picked || !label.value.trim() || targets.length >= 19
  }

  const setPicked = (l: Location | null) => {
    picked = l
    pickedEl.hidden = !l
    pickedEl.textContent = l ? `${kindLabel(l)}: ${l.name}` : ''
    if (l && !label.value.trim()) label.value = l.name ?? ''
    updateSave()
  }

  const runSearch = () => {
    clearTimeout(debounce)
    setPicked(null)
    const q = search.value.trim()
    if (q.length < 2) {
      results.innerHTML = ''
      return
    }
    debounce = setTimeout(async () => {
      const seq = ++searchSeq
      try {
        const found = (await getNetwork(searchNetwork.value).searchLocations(q)).filter(locationQuery).slice(0, 8)
        if (seq !== searchSeq) return
        results.innerHTML = found.length
          ? found
              .map((l, i) => `<li><button type="button" data-i="${i}"><span>${esc(l.name ?? '')}</span><em>${kindLabel(l)}</em></button></li>`)
              .join('')
          : '<li class="empty">Nothing found</li>'
        results.onclick = (ev) => {
          const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-i]')
          if (!b) return
          const l = found[Number(b.dataset.i)]
          search.value = l.name ?? ''
          results.innerHTML = ''
          setPicked(l)
        }
      } catch {
        if (seq === searchSeq) results.innerHTML = '<li class="empty">Search failed. Check your connection.</li>'
      }
    }, 300)
  }
  search.addEventListener('input', runSearch)
  searchNetwork.addEventListener('change', runSearch)

  label.addEventListener('input', updateSave)

  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const q = picked && locationQuery(picked)
    if (!picked || !q || !label.value.trim()) return
    targets.push({
      id: crypto.randomUUID?.() ?? String(Date.now()),
      label: label.value.trim(),
      query: q,
      place: picked.name ?? q,
      network: searchNetwork.value,
    })
    const net = searchNetwork.value
    form.reset()
    searchNetwork.value = net
    setPicked(null)
    void persist()
  })

  renderTargets()
  renderCredits()
}

/** Shows the checked-in journey with a check-out button (hidden when not checked in). */
export function showCheckIn(info: { label: string; arrival: number } | null, onCheckOut: () => void): void {
  const card = $<HTMLElement>('#checkin')
  card.hidden = !info
  if (!info) return
  const t = new Date(info.arrival)
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  $<HTMLParagraphElement>('#checkin-text').textContent = `→ ${info.label} · arrival ${hhmm}`
  $<HTMLButtonElement>('#checkout').onclick = onCheckOut
}

function renderCredits() {
  const link = (url: string, text: string) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`
  $<HTMLDivElement>('#credits').innerHTML = CREDITS.map(
    (g) => `
    <h3>${esc(g.title)}</h3>
    <ul class="list">
      ${g.items
        .map(
          (c) => `
        <li class="card credit">
          <span class="row-title">${link(c.url, c.name)}</span>
          <span class="row-sub-wrap">${esc(c.usedFor)}</span>
          <span class="credit-licence">Licence: ${c.licenceUrl ? link(c.licenceUrl, c.licence) : esc(c.licence)}</span>
          ${c.notice ? `<span class="credit-notice">${esc(c.notice)}</span>` : ''}
          ${c.fullText ? `<details><summary>Licence text</summary><pre>${esc(c.fullText)}</pre></details>` : ''}
        </li>`,
        )
        .join('')}
    </ul>`,
  ).join('')
}

export function setGlassesStatus(text: string): void {
  $<HTMLParagraphElement>('#glasses-status').textContent = text
}
