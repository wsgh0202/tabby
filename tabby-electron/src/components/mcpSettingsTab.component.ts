import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { ChangeDetectorRef, Component, HostBinding, OnDestroy } from '@angular/core'
import { NgModel } from '@angular/forms'
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, PlatformService, VaultService } from 'tabby-core'
import { readMCPPermissions } from '../mcp/access'
import { MCP_GLOBAL_CAPABILITIES } from '../mcp/capabilityLabels'
import { DEFAULT_MCP_HOST, formatMCPAddress, normalizeMCPHost } from '../mcp/listenAddress'
import { MCPToken } from '../mcp/tokens'
import { MCPService } from '../services/mcp.service'
import { getMCPTokenLabel, isMCPTokenEnabled, isMCPTokenMetadata } from '../mcp/tokenDisplay'
import { MCPTokenModalComponent } from './mcpTokenModal.component'

interface MCPTokenRow {
    token: MCPToken
    capabilityCount: number
    includedConnectionCount: number
    invalidPermissions: boolean
}

/** @hidden */
@Component({
    selector: 'mcp-settings-tab',
    templateUrl: './mcpSettingsTab.component.pug',
    styleUrls: ['./mcpSettingsTab.component.scss'],
})
export class MCPSettingsTabComponent implements OnDestroy {
    @HostBinding('class.content-box') contentBox = true
    toolCount = MCP_GLOBAL_CAPABILITIES.length
    tokenLabel = getMCPTokenLabel
    tokenEnabled = isMCPTokenEnabled
    tokenEnabledLabel = _('Enable token: {name}')
    host: string
    port: number|null
    editorOpen = false
    createdToken: string|null = null
    error: string|null = null
    busy = false
    private editorModal: NgbModalRef|null = null
    private destroyed = false
    private restoringToggle = false
    private tokenRowsCache = new WeakMap<MCPToken, MCPTokenRow>()

    constructor (
        public mcp: MCPService,
        public vault: VaultService,
        private config: ConfigService,
        private platform: PlatformService,
        private ngbModal: NgbModal,
        private changeDetector: ChangeDetectorRef,
    ) {
        this.host = mcp.settings.host
        this.port = mcp.settings.port
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.editorModal?.close(null)
        this.createdToken = null
    }

    get previewAddress (): string {
        const port = this.port ?? this.mcp.settings.lastRandomPort
        let host = DEFAULT_MCP_HOST
        try {
            host = normalizeMCPHost(this.host)
        } catch {
            // Invalid drafts must not interrupt settings rendering.
            try { host = normalizeMCPHost(this.mcp.settings.host) } catch { }
        }
        return formatMCPAddress(host, port ?? '<automatic>')
    }

    get wildcardHost (): boolean {
        try {
            const host = normalizeMCPHost(this.mcp.address ? this.mcp.settings.host : this.host)
            return host === '0.0.0.0' || host === '::'
        } catch {
            return false
        }
    }

    get tokenRows (): MCPTokenRow[] {
        const records = this.mcp.settings.tokens
        if (!Array.isArray(records)) { return [] }
        return records.filter(isMCPTokenMetadata).map(token => {
            const cached = this.tokenRowsCache.get(token)
            if (cached) { return cached }
            const permissions = readMCPPermissions(token)
            const row = {
                token,
                capabilityCount: permissions?.capabilities.length ?? 0,
                includedConnectionCount: permissions ? Object.values(permissions.connections).filter(connection => connection.included).length : 0,
                invalidPermissions: permissions === null,
            }
            // Token edits replace their metadata object. Cache only presentation
            // counts, keeping unsupported persisted policies away from bindings.
            this.tokenRowsCache.set(token, row)
            return row
        })
    }

    get invalidTokenRecords (): boolean {
        const records = this.mcp.settings.tokens
        return !Array.isArray(records) || records.some(token => !isMCPTokenMetadata(token))
    }

    trackTokenRow (_index: number, row: MCPTokenRow): string {
        return row.token.id
    }

    async saveSettings (enabled?: boolean): Promise<void> {
        await this.run(async () => {
            const stopping = enabled === false
            let host: string|null = null
            try {
                host = normalizeMCPHost(this.host)
            } catch {
                if (!stopping) {
                    throw new Error(_('MCP listen IP must be a valid IPv4 or IPv6 address'))
                }
            }
            const validPort = this.port === null || (Number.isInteger(this.port) && this.port >= 1 && this.port <= 65535)
            if (!stopping && !validPort) {
                throw new Error(_('MCP port must be between 1 and 65535'))
            }
            const previous = { enabled: this.mcp.settings.enabled, host: this.mcp.settings.host, port: this.mcp.settings.port }
            this.mcp.settings.enabled = enabled ?? previous.enabled
            if (host !== null) { this.mcp.settings.host = host }
            if (validPort) { this.mcp.settings.port = this.port }
            try {
                await this.config.save()
            } catch (error) {
                Object.assign(this.mcp.settings, previous)
                throw error
            }
            if (host !== null) { this.host = host }
            await this.mcp.refresh()
        })
    }

    async setEnabled (enabled: boolean, control: NgModel): Promise<void> {
        if (this.restoringToggle) { return }
        await this.saveSettings(enabled)
        if (this.destroyed || enabled === this.mcp.settings.enabled) { return }
        this.restoreToggle(control, this.mcp.settings.enabled)
    }

    async setTokenEnabled (token: MCPToken, enabled: boolean, control: NgModel): Promise<void> {
        if (this.restoringToggle || this.busy || this.editorOpen || this.createdToken) { return }
        await this.run(() => this.mcp.setTokenEnabled(token.id, enabled))
        if (this.destroyed) { return }
        const current = this.tokenRows.find(row => row.token.id === token.id)?.token
        if (current && enabled !== this.tokenEnabled(current)) {
            this.restoreToggle(control, this.tokenEnabled(current))
        }
    }

    private restoreToggle (control: NgModel, enabled: boolean): void {
        // Commit the toggle's edited view before resetting a rejected change.
        // Reset also emits ngModelChange; ignore that notification, not the error.
        this.changeDetector.detectChanges()
        this.restoringToggle = true
        try { control.reset(enabled) } finally { this.restoringToggle = false }
    }

    async openEditor (token?: MCPToken, configureConnections = false): Promise<void> {
        if (this.busy || this.editorOpen || this.createdToken) { return }
        await this.run(async () => {
            const catalog = await this.mcp.getCatalog()
            if (this.destroyed) { return }
            const modal = this.ngbModal.open(MCPTokenModalComponent, {
                size: 'xl',
                backdrop: 'static',
                ariaLabelledBy: 'mcp-token-title',
                beforeDismiss: () => (modal.componentInstance as MCPTokenModalComponent).canDismiss(),
            })
            const editor = modal.componentInstance as MCPTokenModalComponent
            editor.token = token
            editor.catalog = catalog
            this.editorModal = modal
            this.editorOpen = true
            if (configureConnections) {
                // Keep the normal token editor underneath, with its initialized
                // draft and the usual save/discard flow when returning.
                modal.shown.subscribe(() => {
                    if (!this.destroyed && this.editorModal === modal) {
                        void editor.configureConnections()
                    }
                })
            }
            modal.result.then((created: string|null) => {
                if (!this.destroyed) { this.createdToken = created }
            }).catch(() => null).finally(() => {
                this.editorModal = null
                this.editorOpen = false
            })
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
