/**
 * Push notifications for incoming ZAKA transactions.
 * Polls for new `receive` transactions and fires a browser notification.
 * Requires Notification API permission (requested once on first incoming tx).
 */
import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { ZakaTransaction } from '../types/zaka'

const POLL_INTERVAL = 20_000 // 20 s

export function useNotifications(token: string, active: boolean) {
  const seenIds = useRef<Set<string>>(new Set())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!active || !token) return

    const requestPermission = async () => {
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission()
      }
    }
    void requestPermission()

    const poll = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser(token)
        if (!user) return

        const since = new Date(Date.now() - POLL_INTERVAL * 2).toISOString()
        const { data } = await supabase
          .from('transactions')
          .select('id,type,amount,counterparty,createdAt')
          .eq('userId', user.id)
          .eq('type', 'receive')
          .eq('status', 'complete')
          .gte('createdAt', since)
          .order('createdAt', { ascending: false })
          .limit(5)

        if (!data) return

        for (const tx of data as ZakaTransaction[]) {
          if (seenIds.current.has(tx.id)) continue
          seenIds.current.add(tx.id)

          // Skip on very first load — only notify for truly new transactions
          if (seenIds.current.size === 1) continue

          if ('Notification' in window && Notification.permission === 'granted') {
            const amount = parseFloat(tx.amount).toFixed(2)
            const from = tx.counterparty ?? 'Someone'
            new Notification('💸 ZAKA — Money received!', {
              body: `${from} sent you ${amount} USDC`,
              icon: '/favicon.ico',
              tag: tx.id,
            })
          }
        }
      } catch {
        // silent — don't crash the app on notification errors
      }
    }

    // Seed seen IDs on first run without firing notifications
    const seed = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser(token)
        if (!user) return
        const { data } = await supabase
          .from('transactions')
          .select('id')
          .eq('userId', user.id)
          .eq('type', 'receive')
          .order('createdAt', { ascending: false })
          .limit(20)
        for (const tx of (data ?? []) as { id: string }[]) seenIds.current.add(tx.id)
      } catch { /* silent */ }
    }

    void seed()
    timerRef.current = setInterval(() => void poll(), POLL_INTERVAL)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [token, active])
}
