import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { loadSession } from './lib/auth'
import { useNotifications } from './hooks/useNotifications'
import type { ZakaUser, AppScreen } from './types/zaka'

import SplashScreen from './components/SplashScreen'
import AuthScreen from './components/AuthScreen'
import HomeScreen from './components/HomeScreen'
import SendScreen from './components/SendScreen'
import ReceiveScreen from './components/ReceiveScreen'
import DepositScreen from './components/DepositScreen'
import WithdrawScreen from './components/WithdrawScreen'
import HistoryScreen from './components/HistoryScreen'
import ProfileScreen from './components/ProfileScreen'

const slideVariants = {
  enter: { opacity: 0, x: 28 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -28 },
}

function ScreenWrapper({ children, k }: { children: React.ReactNode; k: string }) {
  return (
    <motion.div
      key={k}
      variants={slideVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}
    >
      {children}
    </motion.div>
  )
}

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('splash')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [user, setUser] = useState<ZakaUser | null>(null)
  const [token, setToken] = useState<string>('')
  const [balance, setBalance] = useState('0.00')

  // Push notifications for incoming transactions
  useNotifications(token, user !== null)

  // Show splash for 3.6 s so all animations complete, then route to auth or home
  useEffect(() => {
    const timer = setTimeout(() => {
      const session = loadSession()
      if (session) {
        setUser(session.user)
        setToken(session.token)
        setScreen('home')
      } else {
        setScreen('login')
      }
    }, 3600)
    return () => clearTimeout(timer)
  }, [])

  const handleAuthSuccess = (u: ZakaUser, t: string) => {
    setUser(u)
    setToken(t)
    setScreen('home')
  }

  const handleLogout = () => {
    setUser(null)
    setToken('')
    setScreen('login')
  }

  const goHome = () => setScreen('home')

  const isAppScreen =
    user !== null &&
    screen !== 'splash' &&
    screen !== 'login' &&
    screen !== 'register'

  return (
    <div style={{ position: 'relative', minHeight: '100dvh', overflow: 'hidden' }}>
      <AnimatePresence mode="wait">

        {/* ── Splash ── */}
        {screen === 'splash' && (
          <motion.div
            key="splash"
            style={{ position: 'absolute', inset: 0 }}
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            <SplashScreen />
          </motion.div>
        )}

        {/* ── Auth ── */}
        {(screen === 'login' || screen === 'register') && (
          <motion.div
            key="auth"
            style={{ position: 'absolute', inset: 0 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
          >
            <AuthScreen
              mode={authMode}
              onSwitch={(m) => { setAuthMode(m); setScreen(m) }}
              onSuccess={handleAuthSuccess}
            />
          </motion.div>
        )}

        {/* ── App screens ── */}
        {isAppScreen && screen === 'home' && (
          <ScreenWrapper k="home">
            <HomeScreen
              user={user}
              token={token}
              onNavigate={(s) => setScreen(s)}
              onLogout={handleLogout}
              onBalanceUpdate={setBalance}
            />
          </ScreenWrapper>
        )}
        {isAppScreen && screen === 'send' && (
          <ScreenWrapper k="send">
            <SendScreen user={user} token={token} onBack={goHome} onSuccess={goHome} />
          </ScreenWrapper>
        )}
        {isAppScreen && screen === 'receive' && (
          <ScreenWrapper k="receive">
            <ReceiveScreen user={user} token={token} onBack={goHome} />
          </ScreenWrapper>
        )}
        {isAppScreen && screen === 'deposit' && (
          <ScreenWrapper k="deposit">
            <DepositScreen user={user} token={token} onBack={goHome} />
          </ScreenWrapper>
        )}
        {isAppScreen && screen === 'withdraw' && (
          <ScreenWrapper k="withdraw">
            <WithdrawScreen user={user} token={token} balance={balance} onBack={goHome} onSuccess={goHome} />
          </ScreenWrapper>
        )}
        {isAppScreen && screen === 'history' && (
          <ScreenWrapper k="history">
            <HistoryScreen token={token} onBack={goHome} />
          </ScreenWrapper>
        )}
        {isAppScreen && screen === 'profile' && (
          <ScreenWrapper k="profile">
            <ProfileScreen user={user} onBack={goHome} onLogout={handleLogout} />
          </ScreenWrapper>
        )}

      </AnimatePresence>
    </div>
  )
}
