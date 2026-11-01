import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, ElementRef, Input, OnDestroy, OnInit, ViewChild } from '@angular/core'
import { NgbActiveModal, NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap'
import { MCPCatalog, MCPPermissions, newMCPPermissions, readMCPPermissions } from '../mcp/access'
import { MCPToken } from '../mcp/tokens'
import { getMCPTokenLabel } from '../mcp/tokenDisplay'
import { MCPService } from '../services/mcp.service'
import { MCPConnectionsModalComponent } from './mcpConnectionsModal.component'

/** @hidden */
@Component({
    templateUrl: './mcpTokenModal.component.pug',
    styleUrls: ['./mcpTokenModal.component.scss'],
})
export class MCPTokenModalComponent implements OnInit, OnDestroy {
    @Input() token?: MCPToken
    @Input() catalog: MCPCatalog = { groups: [], connections: [] }
    @ViewChild('formPage') formPage: ElementRef<HTMLElement>
    navigationLabel = _('Token settings navigation')
    permissions: MCPPermissions = newMCPPermissions()
    name = ''
    activeSection = 'general'
    busy = false
    error: string|null = null
    discardPrompt = false
    connectionsOpen = false
    invalidPermissions = false
    private original = ''
    private discardConfirmed = false
    private connectionsModal: NgbModalRef|null = null
    private destroyed = false

    constructor (
        private mcp: MCPService,
        private modal: NgbActiveModal,
        private ngbModal: NgbModal,
    ) { }

    ngOnInit (): void {
        this.name = this.token?.name ?? ''
        const permissions = readMCPPermissions(this.token)
        this.invalidPermissions = !!this.token && !permissions
        // Unsupported policies start denied in the draft; only Save replaces
        // persisted permissions, so opening or cancelling never migrates grants.
        this.permissions = permissions ? JSON.parse(JSON.stringify(permissions)) : newMCPPermissions()
        this.original = this.snapshot()
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.connectionsModal?.close(null)
    }

    get connectionOperationsEnabled (): boolean {
        return this.permissions.capabilities.includes('connection_operations')
    }

    setConnectionOperations (enabled: boolean): void {
        this.permissions.capabilities = enabled ? ['connection_operations'] : []
    }

    async configureConnections (): Promise<void> {
        if (this.busy || this.connectionsOpen) { return }
        this.connectionsOpen = true
        const ref = this.ngbModal.open(MCPConnectionsModalComponent, {
            size: 'xl',
            windowClass: 'mcp-connections-window',
            backdrop: 'static',
            ariaLabelledBy: 'mcp-connections-title',
        })
        const editor = ref.componentInstance as MCPConnectionsModalComponent
        editor.permissions = this.permissions
        editor.catalog = this.catalog
        editor.tokenName = this.displayName ?? ''
        this.connectionsModal = ref
        try {
            const permissions = await ref.result
            if (permissions && !this.destroyed) { this.permissions = permissions }
        } catch {
            // Discarding connection edits leaves the token draft untouched.
        } finally {
            this.connectionsModal = null
            this.connectionsOpen = false
        }
    }

    get displayName (): string|null {
        const name = this.name.trim()
        if (name) { return name }
        return this.token ? getMCPTokenLabel({ ...this.token, name: '' }) : null
    }

    get dirty (): boolean {
        return this.original !== this.snapshot()
    }

    canDismiss (): boolean {
        if (this.busy) { return false }
        if (this.dirty && !this.discardConfirmed) {
            this.discardPrompt = true
            return false
        }
        return true
    }

    cancel (): void {
        this.modal.dismiss()
    }

    discard (): void {
        this.discardConfirmed = true
        this.modal.dismiss()
    }

    async save (): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.error = null
        try {
            if (this.token) {
                await this.mcp.updateToken(this.token.id, this.permissions, this.name)
                this.modal.close(null)
            } else {
                const token = await this.mcp.createToken(this.name, this.permissions)
                this.modal.close(token)
            }
        } catch (error) {
            this.error = error.message
        } finally {
            this.busy = false
        }
    }

    navigate (section: HTMLElement): void {
        const page = this.formPage.nativeElement
        this.activeSection = section.id
        page.scrollTo({ top: page.scrollTop + section.getBoundingClientRect().top - page.getBoundingClientRect().top })
    }

    updateActiveSection (): void {
        const page = this.formPage.nativeElement
        const sections = Array.from(page.querySelectorAll<HTMLElement>('[data-mcp-section]'))
        if (page.scrollTop + page.clientHeight >= page.scrollHeight - 2) {
            this.activeSection = sections[sections.length - 1].id
            return
        }
        this.activeSection = sections[0].id
        for (const section of sections) {
            if (section.getBoundingClientRect().top - page.getBoundingClientRect().top <= 24) {
                this.activeSection = section.id
            }
        }
    }

    private snapshot (): string {
        return JSON.stringify({ name: this.name, permissions: this.permissions })
    }
}
