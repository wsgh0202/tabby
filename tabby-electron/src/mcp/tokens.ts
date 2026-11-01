import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { Vault, VaultSecret } from 'tabby-core'
import { MCPPermissions, readMCPPermissions, validateMCPPermissions } from './access'
import { getMCPTokenLabel, isMCPTokenMetadata, previewMCPToken } from './tokenDisplay'

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
    /** Encrypted updates and unlock attempts must change this identity; null disables caching. */
    getRevision?: () => object|null
    load: () => Promise<Vault|null>
    addSecret: (secret: VaultSecret) => Promise<void>
    removeSecret: (type: string, key: { id: string }) => Promise<void>
}

interface MCPHashCache {
    revision: object
    hashes: Map<string, string>
}

interface MCPHashLoad {
    revision: object
    promise: Promise<Map<string, string>|null>
}

export function hashMCPToken (token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

/** Plaintext tokens only leave create(); neither configuration nor the vault stores them. */
export class MCPTokens {
    private credentialCache: MCPHashCache|null = null
    private credentialLoad: MCPHashLoad|null = null
    private cacheGeneration = 0

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
            this.clearCredentialCache()
            return null
        }
        const hash = hashMCPToken(token)
        const id = `${MCP_TOKEN_ID_PREFIX}${hash}`
        const revision = this.getRevision()
        const generation = this.cacheGeneration
        const hashes = await this.getCredentialHashes(revision, generation)
        // Deriving the vault key is asynchronous. A lock/disable during that
        // operation must invalidate this check before data or commands proceed.
        if (!this.vault.isEnabled() || !this.vault.isOpen()) {
            this.clearCredentialCache()
            return null
        }
        if (generation !== this.cacheGeneration || revision !== this.getRevision()) { return null }
        const storedHash = hashes?.get(id)
        if (!storedHash || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'))) {
            return null
        }
        // Read permissions after awaiting the vault, so edits/revocations take effect immediately.
        const records = this.getTokens()
        if (!Array.isArray(records)) { return null }
        const entry = records.find(item => isMCPTokenMetadata(item) && item.id === id)
        return entry && readMCPPermissions(entry) ? entry : null
    }

    private getRevision (): object|null {
        return this.vault.getRevision?.() ?? null
    }

    private clearCredentialCache (): void {
        this.credentialCache = null
        this.credentialLoad = null
        this.cacheGeneration++
    }

    /** Cache credential hashes only. Policy and vault lock state are checked on every call. */
    private async getCredentialHashes (revision: object|null, generation: number): Promise<Map<string, string>|null> {
        if (!revision) {
            this.credentialCache = null
            return this.loadCredentialHashes(revision, generation)
        }
        if (this.credentialCache?.revision === revision) { return this.credentialCache.hashes }
        this.credentialCache = null
        if (this.credentialLoad?.revision === revision) { return this.credentialLoad.promise }
        const load: MCPHashLoad = { revision, promise: this.loadCredentialHashes(revision, generation) }
        this.credentialLoad = load
        try {
            const hashes = await load.promise
            if (hashes && this.credentialLoad === load && generation === this.cacheGeneration
                && revision === this.getRevision() && this.vault.isEnabled() && this.vault.isOpen()) {
                this.credentialCache = { revision, hashes }
            }
            return hashes
        } finally {
            // An obsolete load must not clear a newer revision's in-flight decryption.
            if (this.credentialLoad === load) { this.credentialLoad = null }
        }
    }

    private async loadCredentialHashes (revision: object|null, generation: number): Promise<Map<string, string>|null> {
        const vault = await this.vault.load()
        if (!this.vault.isEnabled() || !this.vault.isOpen()) {
            this.clearCredentialCache()
            return null
        }
        if (generation !== this.cacheGeneration || revision !== this.getRevision()) { return null }
        const hashes = new Map<string, string>()
        for (const secret of vault?.secrets ?? []) {
            const id = secret.key['id']
            if (secret.type === MCP_TOKEN_TYPE && typeof id === 'string' && id.startsWith(MCP_TOKEN_ID_PREFIX)
                && /^[a-f0-9]{64}$/.test(secret.value)) {
                hashes.set(id, secret.value)
            }
        }
        return hashes
    }
}
