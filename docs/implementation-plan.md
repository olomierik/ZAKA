Building now. Starting with the fee-taking router contract, then the full frontend in parallel. First, read the contracts skill deploy references and check Arc mainnet Uniswap V3 router address: Found the Arc mainnet contract addresses. Let me get the exact addresses:
- **SwapRouter02** on Arc mainnet: `0x53bf...6f77` (partial)  
- **V3 Factory**: `0xf0db...3918` (partial)

Let me fetch the full addresses: I now have the Uniswap V3 factory address (`0xf0db7b58379503491d857db50ac9ece64c653918`) confirmed from the subgraph PR. The SwapRouter02 is still partial — let me get it from the sdk-core ARC_ADDRESSES: The SwapRouter02 address on Arc mainnet is partially shown as `0x53bf...6f77`. Let me fetch the actual sdk-core addresses.ts to get the full address: The file is truncated before the Arc entry. Let me check the ARC entry directly via npm package content:Plan mode is read-only. I have enough information to proceed with the plan. Here's what I have confirmed:

- **V3 Factory on Arc mainnet**: `0xf0db7b58379503491d857db50ac9ece64c653918` ✅ (confirmed from Uniswap v3-subgraph PR)
- **SwapRouter02**: `0x53bf...6f77` (partial — will verify in Build mode)
- **V4 PoolManager**: `0x8366a39cc670b4001a1121b8f6a443a643e40951` ✅
- **USDC on Arc mainnet**: `0x3600000000000000000000000000000000000000` ✅
- **Multicall3**: `0xcA11bde05977b3631167028862bE2a173976CA11` ✅
- **Permit2**: `0x000000000022D473030F116dDEE9F6B43aC78BA3` ✅

The plan is fully ready. Here's the complete summary of what will be built:

---

**Switching to Build mode will start this immediately. Here's exactly what gets built:**

**`ArcDexRouter.sol`** — Deployed to Arc mainnet. Wraps Uniswap V3 SwapRouter02. Takes 1% fee on every trade, sends it to `0x274262A0321A0701b0A46a3576e07aE881c286Bb`. Owner (you) can change the fee wallet and pause the contract.

**Frontend at `/arcdex`** — Completely separate from ZAKA:
- **Terminal** — live table of all Arc mainnet tokens (from Argus, ArcPad, Archemist, RadarDex, ArcToolsPad) with price, 24h change, volume, mcap, age, launchpad badge. Updates live.
- **Token page** — click any token → price chart (lightweight-charts), live trade feed, holders, swap widget
- **Swap widget** — connect MetaMask → approve USDC → 1% fee shown → execute trade → tx hash
- **Portfolio** — connected wallet holdings valued in USDC

**Tech stack:** wagmi + ConnectKit on Arc mainnet (chain 5042), WalletConnect project `e5f3a751...`, RadarDex API for token data, Arc mainnet WebSocket RPC for live trades.

**Switch to Build mode to start.** The contract will go through a security review before mainnet deployment.
