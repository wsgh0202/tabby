import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, HostBinding, OnDestroy } from '@angular/core'
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, PlatformService, VaultService } from 'tabby-core'
import { MCP_TOOLS } from '../mcp/access'
import { MCPToken } from '../mcp/tokens'
import { MCPService } from '../services/mcp.service'
import { getMCPTokenLabel } from '../mcp/tokenDisplay'
import { MCPTokenModalComponent } from './mcpTokenModal.component'

/** @hidden */
@Component({
    selector: 'mcp-settings-tab',
    templateUrl: './mcpSettingsTab.component.pug',
    styleUrls: ['./mcpSettingsTab.component.scss'],
})
export class MCPSettingsTabComponent implements OnDestroy {
    @HostBinding('class.content-box') contentBox = true
    toolCount = MCP_TOOLS.length
    tokenLabel = getMCPTokenLabel
    port: number|null
    editorOpen = false
    createdToken: string|null = null
    error: string|null = null
    busy = false
    private editorModal: NgbModalRef|null = null
    private destroyed = false

    constructor (
        public mcp: MCPService,
        public vault: VaultService,
        private config: ConfigService,
        private platform: PlatformService,
        private ngbModal: NgbModal,
    ) {
        this.port = mcp.settings.port
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.editorModal?.close(null)
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
                throw new Error(_('MCP port must be between 1 and 65535'))
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
