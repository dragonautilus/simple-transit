import './style.css'
import { getBridge } from './bridge'
import { mountCompanion, setGlassesStatus, showCheckIn } from './companion'
import { GlassesApp } from './glasses'

let glasses: GlassesApp | null = null

// Glasses first: the Even app shows "app starting" until the first glasses page exists, so
// nothing (not even the phone page's storage reads) may queue in front of it.
const bridge = await getBridge()
if (bridge) {
  setGlassesStatus('Starting on glasses…')
  glasses = new GlassesApp(bridge, (s) => {
    setGlassesStatus(s.summary)
    showCheckIn(s.checkIn, () => void glasses?.checkOut())
  })
  glasses.start().catch((err) => setGlassesStatus(`Glasses error: ${err instanceof Error ? err.message : err}`))
}

await mountCompanion(
  (targets) => void glasses?.setTargets(targets),
  (settings) => void glasses?.setSettings(settings),
)
if (!bridge) setGlassesStatus('Not running inside the Even app. Targets are stored in this browser only.')
