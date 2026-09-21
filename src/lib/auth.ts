import type { ZakaUser } from '../types/zaka'

const USER_KEY = 'zaka_user'
const TOKEN_KEY = 'zaka_token'

export function saveSession(user: ZakaUser, token: string) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  localStorage.setItem(TOKEN_KEY, token)
}

export function loadSession(): { user: ZakaUser; token: string } | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    const token = localStorage.getItem(TOKEN_KEY)
    if (!raw || !token) return null
    return { user: JSON.parse(raw) as ZakaUser, token }
  } catch {
    return null
  }
}

export function clearSession() {
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(TOKEN_KEY)
}
