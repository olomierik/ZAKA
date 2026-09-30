// Email for bot accounts (owner's decision, 2026-09-30: Resend): the
// verification code at sign-up, a new passcode when one is forgotten, and
// the code that confirms a withdrawal from a live bot's wallet.
//
// RESEND_API_KEY switches it on; MAIL_FROM is the sender, on a domain
// verified in Resend (default "ARCDEX <bots@arcdex.online>"). Without the
// key the engine still signs people up, but can't verify an email, reset a
// passcode or confirm a withdrawal, and says so. Nothing sent is logged
// beyond the recipient's domain and Resend's id (codes and passcodes never).

import { errMsg, log } from '../log'

export interface Mail { to: string; subject: string; text: string; html?: string }

export interface Mailer {
  readonly enabled: boolean
  send(m: Mail): Promise<void>
}

export class ResendMailer implements Mailer {
  readonly enabled = true
  constructor(private apiKey: string, private from: string, private fetchFn: typeof fetch = fetch) {}
  async send(m: Mail) {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => ({})) as { id?: string; message?: string }
    if (!res.ok) throw new Error(`email not sent: ${body.message ?? `Resend answered ${res.status}`}`)
    log.info('email sent', { to: m.to.replace(/^[^@]*/, '…'), id: body.id })
  }
}

/** No email service configured: every send fails with that reason. */
export class NoMailer implements Mailer {
  readonly enabled = false
  async send(): Promise<void> { throw new Error('email is not set up on this engine (RESEND_API_KEY)') }
}

/** Tests: keeps what would have been sent. */
export class MemoryMailer implements Mailer {
  readonly enabled = true
  readonly sent: Mail[] = []
  async send(m: Mail) { this.sent.push(m) }
}

export function mailerFromEnv(env = process.env): Mailer {
  const key = env.RESEND_API_KEY?.trim()
  if (!key) return new NoMailer()
  return new ResendMailer(key, env.MAIL_FROM?.trim() || 'ARCDEX <bots@arcdex.online>')
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** A short plain email with one highlighted value (a code or passcode). */
export function codeMail(to: string, subject: string, intro: string, value: string, outro: string): Mail {
  return {
    to, subject,
    text: `${intro}\n\n    ${value}\n\n${outro}\n\nARCDEX Autotrade · arcdex.online`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#0f172a">
<p>${esc(intro)}</p>
<p style="font-size:28px;font-weight:800;letter-spacing:6px;font-family:ui-monospace,monospace;background:#f1f5f9;padding:14px 18px;border-radius:10px;text-align:center">${esc(value)}</p>
<p style="color:#475569">${esc(outro)}</p>
<p style="color:#94a3b8;font-size:12px">ARCDEX Autotrade · arcdex.online</p></div>`,
  }
}

export const logMailError = (what: string, e: unknown) => log.warn(`email: ${what} failed`, { error: errMsg(e) })
