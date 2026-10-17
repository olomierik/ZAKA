// A page that fails to draw shows what happened and a way on, instead of taking the whole app down with it (a blank
// screen). A page whose code file is gone after a deploy reloads once to get the new version (lib/chunkReload.ts).

import { Component, type ReactNode } from 'react'
import { t as T } from '../lib/i18n'
import { isChunkError, reloadForNewVersion } from '../lib/chunkReload'

interface Props {
  children: ReactNode
  /** A new value (the page's path) clears the error, so moving to another page works. */
  resetKey: string
  /** Shown instead of the default panel; `null` shows nothing (for parts of the page that can just disappear). */
  fallback?: ReactNode
  onHome?: () => void
}

export default class PageErrorBoundary extends Component<Props, { error: Error | null; reloading: boolean }> {
  state = { error: null as Error | null, reloading: false }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidCatch(error: Error) {
    if (isChunkError(error) && reloadForNewVersion()) this.setState({ reloading: true })
    else console.error('ARCDEX page error:', error)
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, reloading: false })
  }

  render() {
    const { error, reloading } = this.state
    if (!error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    const chunk = isChunkError(error)
    return (
      <div className="page-error" role="alert">
        <b>{chunk ? T('ARCDEX was just updated') : T('This page couldn’t be shown')}</b>
        <p>{reloading ? T('Loading the new version…') : chunk ? T('Reload to get the new version of this page.') : T('Something went wrong while drawing it. Reloading usually fixes it; your wallet and orders aren’t affected.')}</p>
        {!chunk && <code>{error.message.slice(0, 200)}</code>}
        <div className="page-error-btns">
          <button className="btn-primary" onClick={() => window.location.reload()}>{T('Reload')}</button>
          {this.props.onHome && <button className="btn-ghost" onClick={() => { this.setState({ error: null }); this.props.onHome?.() }}>{T('Go to Trenches')}</button>}
        </div>
      </div>
    )
  }
}
