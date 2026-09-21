/**
 * Registers the entity secret from .env with Circle and writes the recovery file.
 * Run once: bun scripts/register-entity.mjs
 */
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets'
import fs from 'node:fs'
import path from 'node:path'

const apiKey       = process.env.CIRCLE_DEVELOPER_CONTROLLED_API_KEY ?? process.env.CIRCLE_API_KEY ?? ''
const entitySecret = process.env.CIRCLE_ENTITY_SECRET ?? process.env.ENTITY_SECRET ?? ''

if (!apiKey || !entitySecret) {
  console.error('CIRCLE_DEVELOPER_CONTROLLED_API_KEY and CIRCLE_ENTITY_SECRET must be set')
  process.exit(1)
}
if (entitySecret.length !== 64) {
  console.error('Entity secret must be 64 hex chars (32 bytes). Got length:', entitySecret.length)
  process.exit(1)
}

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
  fs.writeFileSync(recoveryPath, response.data.recoveryFile)
  console.log('Recovery file written to:', recoveryPath)
}

console.log('Entity secret registered successfully.')
console.log('Recovery file path:', recoveryPath)
