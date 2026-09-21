/**
 * Test: create a Circle wallet set + wallet using the SDK directly
 * to confirm the API key + entity secret work end-to-end.
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'

const apiKey       = process.env.CIRCLE_DEVELOPER_CONTROLLED_API_KEY ?? ''
const entitySecret = process.env.CIRCLE_ENTITY_SECRET ?? ''

if (!apiKey || !entitySecret) {
  console.error('Missing CIRCLE_DEVELOPER_CONTROLLED_API_KEY or CIRCLE_ENTITY_SECRET')
  process.exit(1)
}

const sdk = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret })

// 1. List wallet sets (read-only — confirms ciphertext flow works)
console.log('Listing wallet sets...')
const wsRes = await sdk.listWalletSets({ pageSize: 5 })
const sets = wsRes.data?.walletSets ?? []
console.log('Wallet sets found:', sets.length)

let walletSetId = sets[0]?.id

if (!walletSetId) {
  console.log('No wallet set found — creating one...')
  const createRes = await sdk.createWalletSet({ name: 'ZAKA WalletSet' })
  walletSetId = createRes.data?.walletSet?.id
  console.log('Created wallet set:', walletSetId)
} else {
  console.log('Using existing wallet set:', walletSetId)
}

// 2. Create one wallet on ARC-TESTNET
console.log('Creating ARC-TESTNET wallet...')
const walletRes = await sdk.createWallets({
  accountType: 'EOA',
  blockchains: ['ARC-TESTNET'],
  count: 1,
  walletSetId,
})
const wallet = walletRes.data?.wallets?.[0]
console.log('Wallet created:')
console.log('  ID:      ', wallet?.id)
console.log('  Address: ', wallet?.address)
console.log('  Chain:   ', wallet?.blockchain)
console.log()
console.log('SUCCESS — entity secret is valid and wallets can be created.')
