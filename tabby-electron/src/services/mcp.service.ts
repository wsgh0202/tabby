import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Inject, Injectable } from '@angular/core'
import { BOOTSTRAP_DATA, BootstrapData, ConfigService, ProfilesService, VaultService } from 'tabby-core'
import { MCPCatalog, MCPPermissions, validateMCPPermissions } from '../mcp/access'
import { MCPHTTPServer } from '../mcp/server'
import { MCPToken, MCPTokens } from '../mcp/tokens'
import { ElectronService } from './electron.service'

export interface MCPSettings {
    enabled: boolean
    port: number|null
    lastRandomPort: number|null
    tokens: MCPToken[]
}

@Injectable({ providedIn: 'root' })
export class MCPService {
    error: string|null = null
    private server: MCPHTTPServer
    private tokens: MCPTokens
    private pending = Promise.resolve()
    private tokenUpdates = Promise.resolve()
    private appliedSettings: string|null = null
    private closing = false

    constructor (
        private config: ConfigService,
        private profiles: ProfilesService,
        private vault: VaultService,
        @Inject(BOOTSTRAP_DATA) private bootstrap: BootstrapData,
        electron: ElectronService,
    ) {
        this.tokens = new MCPTokens(vault, () => this.settings.tokens)
        this.server = new MCPHTTPServer({
            authenticate: async token => {
                const entry = await this.tokens.authenticate(token)
                return this.settings.enabled && !this.closing ? entry : null
            },
            getCatalog: () => this.getCatalog(),
        })
        config.ready$.toPromise().then(() => this.refresh())
        config.changed$.subscribe(() => this.refresh())
        electron.ipcRenderer.on('host:became-main-window', () => {
            this.bootstrap.isMainWindow = true
            this.refresh()
        })
        window.addEventListener('beforeunload', () => {
            this.closing = true
            this.server.stop()
        })
    }

    get settings (): MCPSettings {
        return this.config.store.mcp
    }

    get address (): string|null {
        return this.settings.enabled ? this.server.address : null
    }

    get isMainWindow (): boolean {
        return this.bootstrap.isMainWindow
    }

    /** Only the main window owns the listener. Serialize restarts caused by config broadcasts. */
    refresh (): Promise<void> {
        this.pending = this.pending.then(async () => {
            if (!this.canListen()) {
                return
            }
            const { enabled, port, lastRandomPort } = this.settings
            const signature = JSON.stringify({ enabled, port })
            if (this.appliedSettings === signature) {
                return
            }
            this.error = null
            await this.server.stop()
            if (!this.canListen()) { return }
            if (enabled) {
                const actualPort = await this.server.start(port, lastRandomPort)
                if (!this.canListen()) { await this.server.stop(); return }
                if (port === null && actualPort !== lastRandomPort) {
                    this.settings.lastRandomPort = actualPort
                    await this.config.save()
                }
            }
            this.appliedSettings = signature
        }).catch(async error => {
            await this.server.stop()
            this.appliedSettings = null
            this.error = error.code === 'EADDRINUSE' ? _('MCP port is already in use') : _('Could not start MCP server')
        })
        return this.pending
    }

    private canListen (): boolean {
        return !this.closing && this.bootstrap.isMainWindow
    }

    async getCatalog (): Promise<MCPCatalog> {
        const groups = await this.profiles.getProfileGroups({ includeProfiles: true, includeNonUserGroup: true })
        return {
            groups: groups.map(group => ({ id: group.id, name: group.name })),
            connections: groups.flatMap(group => (group.profiles ?? [])
                .filter(profile => profile.id && !profile.isTemplate)
                .map(profile => ({ id: profile.id!, name: profile.name, type: profile.type, group: group.id }))),
        }
    }

    async createToken (name: string, permissions: MCPPermissions): Promise<string> {
        return this.mutateTokens(async () => {
            const { entry, token } = await this.tokens.create(name, permissions)
            this.settings.tokens = [...this.settings.tokens, entry]
            try {
                await this.config.save()
            } catch (error) {
                this.settings.tokens = this.settings.tokens.filter(item => item.id !== entry.id)
                await this.tokens.remove(entry.id)
                throw error
            }
            return token
        })
    }

    async updateToken (id: string, permissions: MCPPermissions): Promise<void> {
        return this.mutateTokens(async () => {
            validateMCPPermissions(permissions)
            const previous = this.settings.tokens
            if (!previous.some(token => token.id === id)) {
                throw new Error(_('MCP token no longer exists'))
            }
            this.settings.tokens = previous.map(token => token.id === id ? { ...token, ...JSON.parse(JSON.stringify(permissions)) } : token)
            try {
                await this.config.save()
            } catch (error) {
                this.settings.tokens = previous
                throw error
            }
        })
    }

    async removeToken (id: string): Promise<void> {
        return this.mutateTokens(async () => {
            // Remove the credential first: a failed config write must never restore access.
            await this.tokens.remove(id)
            this.settings.tokens = this.settings.tokens.filter(token => token.id !== id)
            await this.config.save()
        })
    }

    private mutateTokens<T> (mutation: () => Promise<T>): Promise<T> {
        // Several settings tabs share this service. Vault mutations read and save a
        // snapshot, so serialize the whole transaction, including metadata rollback.
        const result = this.tokenUpdates.then(mutation)
        this.tokenUpdates = result.then(() => undefined, () => undefined)
        return result
    }

    async unlockVault (): Promise<void> {
        await this.vault.load()
    }
}
