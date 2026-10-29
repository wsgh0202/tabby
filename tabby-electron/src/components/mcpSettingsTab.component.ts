import { Component, HostBinding, OnDestroy, OnInit } from '@angular/core'
import { ConfigService, PlatformService, VaultService } from 'tabby-core'
import { MCPCatalog, MCPPermissions, MCP_TOOLS, newMCPPermissions } from '../mcp/access'
import { MCPToken } from '../mcp/tokens'
import { MCPService } from '../services/mcp.service'

/** @hidden */
@Component({
    selector: 'mcp-settings-tab',
    templateUrl: './mcpSettingsTab.component.pug',
})
export class MCPSettingsTabComponent implements OnInit, OnDestroy {
    @HostBinding('class.content-box') contentBox = true
    tools = MCP_TOOLS
    catalog: MCPCatalog = { groups: [], connections: [] }
    port: number|null
    name = ''
    permissions: MCPPermissions = newMCPPermissions()
    editing: string|null = null
    editorOpen = false
    createdToken: string|null = null
    error: string|null = null
    busy = false

    constructor (
        public mcp: MCPService,
        public vault: VaultService,
        private config: ConfigService,
        private platform: PlatformService,
    ) {
        this.port = mcp.settings.port
    }

    async ngOnInit (): Promise<void> {
        await this.run(async () => { this.catalog = await this.mcp.getCatalog() })
    }

    ngOnDestroy (): void {
        this.createdToken = null
    }

    get previewAddress (): string {
        const port = this.port ?? this.mcp.settings.lastRandomPort
        return port ? `http://127.0.0.1:${port}/mcp` : 'http://127.0.0.1:<automatic>/mcp'
    }

    async saveSettings (enabled = this.mcp.settings.enabled): Promise<void> {
        await this.run(async () => {
            const validPort = this.port === null || (Number.isInteger(this.port) && this.port >= 1 && this.port <= 65535)
            if (enabled && !validPort) {
                throw new Error('MCP port must be between 1 and 65535')
            }
            const previous = { enabled: this.mcp.settings.enabled, port: this.mcp.settings.port }
            this.mcp.settings.enabled = enabled
            if (validPort) { this.mcp.settings.port = this.port }
            try {
                await this.config.save()
            } catch (error) {
                Object.assign(this.mcp.settings, previous)
                throw error
            }
            await this.mcp.refresh()
        })
    }

    async openEditor (token?: MCPToken): Promise<void> {
        await this.run(async () => {
            this.catalog = await this.mcp.getCatalog()
            this.editing = token?.id ?? null
            this.name = token?.name ?? ''
            this.permissions = token ? JSON.parse(JSON.stringify({ tools: token.tools, connections: token.connections, groups: token.groups })) : newMCPPermissions()
            this.editorOpen = true
        })
    }

    async saveToken (): Promise<void> {
        await this.run(async () => {
            if (this.editing) {
                await this.mcp.updateToken(this.editing, this.permissions)
            } else {
                this.createdToken = await this.mcp.createToken(this.name, this.permissions)
            }
            this.editorOpen = false
        })
    }

    async removeToken (token: MCPToken): Promise<void> {
        await this.run(() => this.mcp.removeToken(token.id))
    }

    async unlockVault (): Promise<void> {
        await this.run(() => this.mcp.unlockVault())
    }

    copy (text: string): void {
        this.platform.setClipboard({ text })
    }

    toggleSelection (items: string[], id: string, selected: boolean): void {
        const index = items.indexOf(id)
        if (selected && index === -1) {
            items.push(id)
        } else if (!selected && index !== -1) {
            items.splice(index, 1)
        }
    }

    private async run (action: () => Promise<void>): Promise<void> {
        this.busy = true
        this.error = null
        try {
            await action()
        } catch (error) {
            this.error = error.message
        } finally {
            this.busy = false
        }
    }
}
