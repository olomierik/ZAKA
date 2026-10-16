// Mounts Privy (PrivyRoot.tsx, its own chunk) once something asks for it: "Email or social" in the connect window, or a
// browser that was signed in before (privy/state.ts initPrivy). Nothing is loaded for anyone else.

import { Component, lazy, Suspense, type ReactNode } from 'react'
import { N_ } from '../lib/i18n'
import { isChunkError, reloadForNewVersion } from '../lib/chunkReload'
import { PRIVY_APP_ID, setPrivyState, usePrivyOn, usePrivyState } from './state'

const PrivyRoot = lazy(() => import('./PrivyRoot'))

/** Privy failing to load or draw takes nothing else down: the sign-in says it couldn't be reached. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(e: Error) {
    // Privy's file is gone after a deploy: the new version has it.
    if (isChunkError(e) && reloadForNewVersion()) return
    console.error('ARCDEX: Privy failed to load', e)
    setPrivyState({ error: N_('Email sign-in couldn’t be reached. Try again, or use another wallet.') })
  }
  render() { return this.state.failed ? null : this.props.children }
}

export default function PrivyHost() {
  const on = usePrivyOn()
  const { started } = usePrivyState()
  if (!on || !started) return null
  return <Quiet><Suspense fallback={null}><PrivyRoot appId={PRIVY_APP_ID} /></Suspense></Quiet>
}
