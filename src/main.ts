import './style.css'
import { getBridge } from './bridge'
import { mountCompanion, setGlassesStatus, showCheckIn } from './companion'
import { GlassesApp } from './glasses'

let glasses: GlassesApp | null = null

await mountCompanion(
  (targets) => void glasses?.setTargets(targets),
  (settings) => void glasses?.setSettings(settings),
)

const bridge = await getBridge()
if (!bridge) {
  setGlassesStatus('Not running inside the Even app. Targets are stored in this browser only.')
} else {
  glasses = new GlassesApp(bridge, (s) => {
    setGlassesStatus(s.summary)
    showCheckIn(s.checkIn, () => void glasses?.checkOut())
  })
  setGlassesStatus('Starting on glasses…')
  glasses.start().catch((err) => setGlassesStatus(`Glasses error: ${err instanceof Error ? err.message : err}`))
}
