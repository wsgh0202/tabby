import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { Vault, VaultSecret } from 'tabby-core'
import { MCPPermissions, validateMCPPermissions } from './access'
import { getMCPTokenLabel, previewMCPToken } from './tokenDisplay'

export const MCP_TOKEN_TYPE = 'custom:password'
export const MCP_TOKEN_ID_PREFIX = 'mcp:token:'
export const MCP_TOKEN_DESCRIPTION_PREFIX = 'MCP token: '

export interface MCPToken extends MCPPermissions {
    id: string
    name: string
    preview?: string
}

export interface MCPTokenVault {
    isEnabled: () => boolean
    isOpen: () => boolean
    load: () => Promise<Vault|null>
    addSecret: (secret: VaultSecret) => Promise<void>
    removeSecret: (type: string, key: { id: string }) => Promise<void>
}

export function hashMCPToken (token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

/** Plaintext tokens only leave create(); neither configuration nor the vault stores them. */
export class MCPTokens {
    constructor (private vault: MCPTokenVault, private getTokens: () => MCPToken[]) { }

    async create (name: string, permissions: MCPPermissions): Promise<{ token: string, entry: MCPToken }> {
        name = name.trim()
        validateMCPPermissions(permissions)
        if (!this.vault.isEnabled()) {
            throw new Error(_('Configure the vault before creating an MCP token'))
        }
        const token = randomBytes(32).toString('hex')
        const hash = hashMCPToken(token)
        const id = `${MCP_TOKEN_ID_PREFIX}${hash}`
        const entry: MCPToken = { ...JSON.parse(JSON.stringify(permissions)), id, name, preview: previewMCPToken(token) }
        await this.vault.addSecret({
            type: MCP_TOKEN_TYPE,
            key: { id, description: `${MCP_TOKEN_DESCRIPTION_PREFIX}${getMCPTokenLabel(entry)}` },
            value: hash,
        })
        return { token, entry }
    }

    async remove (id: string): Promise<void> {
        await this.vault.removeSecret(MCP_TOKEN_TYPE, { id })
    }

    async authenticate (token: string): Promise<MCPToken|null> {
        // Network traffic must never open a vault unlock dialog. Unlock locally in settings.
        if (!this.vault.isEnabled() || !this.vault.isOpen()) {
            return null
        }
        const hash = hashMCPToken(token)
        const id = `${MCP_TOKEN_ID_PREFIX}${hash}`
        const vault = await this.vault.load()
        const secret = vault?.secrets.find(item => item.type === MCP_TOKEN_TYPE && item.key['id'] === id)
        if (!secret || !/^[a-f0-9]{64}$/.test(secret.value)
            || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(secret.value, 'hex'))) {
            return null
        }
        // Read permissions after awaiting the vault, so edits/revocations take effect immediately.
        return this.getTokens().find(entry => entry.id === id) ?? null
    }
}
