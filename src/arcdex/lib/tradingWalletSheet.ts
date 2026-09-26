// Opens the trading-wallet panel as a sheet from anywhere (App.tsx listens).
// On phones and tablets the right rail that holds it isn't shown, so every
// "trading wallet" mention links here instead of pointing at a panel.
export const OPEN_TRADING_WALLET = 'arcdex:open-trading-wallet'
export const openTradingWallet = () => window.dispatchEvent(new Event(OPEN_TRADING_WALLET))
