import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { registerEntitySecretCiphertext, initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'

// Manually load .env since this script runs outside of bun's auto-load context
const envFile = '/home/user/app/.env'
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key && !(key in process.env)) process.env[key] = val
  }
}

const apiKey = process.env.CIRCLE_DEVELOPER_CONTROLLED_API_KEY
if (!apiKey) {
  console.error('ERROR: CIRCLE_DEVELOPER_CONTROLLED_API_KEY is not set in .env')
  process.exit(1)
}

// 1. Generate a fresh 32-byte entity secret (never printed to stdout)
const entitySecret = crypto.randomBytes(32).toString('hex')

// 2. Register with Circle and save recovery file under /home/user/app
const recoveryDir = '/home/user/app/.circle'
fs.mkdirSync(recoveryDir, { recursive: true })

console.log('Registering entity secret with Circle...')
const response = await registerEntitySecretCiphertext({
  apiKey,
  entitySecret,
  recoveryFileDownloadPath: recoveryDir,
})

const recoveryPath = path.join(recoveryDir, 'recovery_file.dat')
if (response.data?.recoveryFile) {
  fs.writeFileSync(recoveryPath, response.data.recoveryFile, 'utf-8')
}

if (!fs.existsSync(recoveryPath)) {
  console.error('ERROR: Recovery file was not written. Registration may have failed.')
  process.exit(1)
}

// 3. Persist secret to .env
const envPath = '/home/user/app/.env'
fs.appendFileSync(envPath, `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`, 'utf-8')

// 4. Verify by calling a read-only endpoint
const client = initiateDeveloperControlledWalletsClient({
  apiKey,
  entitySecret,
})

try {
  await client.listWalletSets({ pageSize: 1 })
  console.log('SUCCESS: Entity secret registered and verified.')
  console.log('RECOVERY_PATH:' + recoveryPath)
} catch (err) {
  console.error('ERROR: Verification failed after registration:', err)
  process.exit(1)
}
