import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, ElementRef, Input, OnInit, ViewChild } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { MCPCatalog, MCPConnection, MCPPermissions, MCP_TOOLS, newMCPPermissions } from '../mcp/access'
import { MCPToken } from '../mcp/tokens'
import { getMCPTokenLabel } from '../mcp/tokenDisplay'
import { MCPService } from '../services/mcp.service'

const TOOL_LABELS = {
    list_connection_groups: _('View connection groups'),
    list_connections: _('View connections'),
    list_group_connections: _('View connections in a group'),
}

/** @hidden */
@Component({
    templateUrl: './mcpTokenModal.component.pug',
    styleUrls: ['./mcpTokenModal.component.scss'],
})
export class MCPTokenModalComponent implements OnInit {
    @Input() token?: MCPToken
    @Input() catalog: MCPCatalog = { groups: [], connections: [] }
    @ViewChild('formPage') formPage: ElementRef<HTMLElement>
    tools = MCP_TOOLS.map(tool => ({ ...tool, label: TOOL_LABELS[tool.name] }))
    navigationLabel = _('Token settings navigation')
    permissions: MCPPermissions = newMCPPermissions()
    name = ''
    activeSection = 'general'
    busy = false
    error: string|null = null
    discardPrompt = false
    private original = ''
    private discardConfirmed = false

    constructor (
        private mcp: MCPService,
        private modal: NgbActiveModal,
    ) { }

    ngOnInit (): void {
        this.name = this.token?.name ?? ''
        if (this.token) {
            const { tools, groups, connections } = this.token
            this.permissions = JSON.parse(JSON.stringify({ tools, groups, connections }))
        }
        this.original = this.snapshot()
    }

    get displayName (): string|null {
        return this.name.trim() ? this.name.trim() : this.token ? getMCPTokenLabel({ ...this.token, name: '' }) : null
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

    toggleSelection (items: string[], id: string, selected: boolean): void {
        const index = items.indexOf(id)
        if (selected && index === -1) { items.push(id) }
        if (!selected && index !== -1) { items.splice(index, 1) }
    }

    grantedByGroup (connection: MCPConnection): boolean {
        return this.permissions.groups.mode === 'all' || this.permissions.groups.ids.includes(connection.group)
    }

    groupName (id: string): string {
        return this.catalog.groups.find(group => group.id === id)?.name ?? id
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
