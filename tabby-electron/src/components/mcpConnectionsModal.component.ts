import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Input, OnDestroy, OnInit } from '@angular/core'
import { NgbActiveModal, NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap'
import { MCPCatalog, MCPGroup, MCPPermissions, newMCPPermissions } from '../mcp/access'
import { MCP_CAPABILITY_LABELS } from '../mcp/capabilityLabels'
import { MCPConnectionEditor, MCPGroupNavigationEntry, MCPPolicyRow } from '../mcp/connectionEditor'
import { MCPBatchModalComponent } from './mcpBatchModal.component'

/** @hidden */
@Component({
    templateUrl: './mcpConnectionsModal.component.pug',
    styleUrls: ['./mcpConnectionsModal.component.scss'],
})
export class MCPConnectionsModalComponent implements OnInit, OnDestroy {
    @Input() permissions: MCPPermissions = newMCPPermissions()
    @Input() catalog: MCPCatalog = { groups: [], connections: [] }
    @Input() tokenName = ''
    editor: MCPConnectionEditor
    capabilities = MCP_CAPABILITY_LABELS
    navigationLabel = _('Connection groups')
    searchLabel = _('Find a group')
    inheritedLabel = _('Inherited')
    independentLabel = _('Independent')
    enabledLabel = _('Enabled')
    disabledLabel = _('Disabled')
    includeGroupLabel = _('Include connections in this group')
    includeConnectionLabel = _('Include connection')
    resetOverridesLabel = _('Reset overrides')
    batchOpen = false
    private batchModal: NgbModalRef|null = null
    private destroyed = false

    constructor (
        public modal: NgbActiveModal,
        private ngbModal: NgbModal,
    ) { }

    ngOnInit (): void {
        // The parent receives this draft only when the user confirms the dialog.
        this.editor = new MCPConnectionEditor(JSON.parse(JSON.stringify(this.permissions)), this.catalog)
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.batchModal?.close(null)
    }

    groupIcon (group: MCPGroup, collapsed = false): string {
        if (group.icon) { return group.icon }
        return collapsed ? 'far fa-folder' : 'far fa-folder-open'
    }

    toggleCollapsed (collection: Set<string>, id: string): void {
        if (collection.has(id)) { collection.delete(id) } else { collection.add(id) }
    }

    trackRow (_index: number, row: MCPPolicyRow): string {
        return `${row.group ? 'group' : 'connection'}:${row.id}`
    }

    trackGroup (_index: number, entry: MCPGroupNavigationEntry): string {
        return entry.group.id
    }

    resetRow (id: string, scopeCheckbox: HTMLInputElement): void {
        this.editor.resetConnection(id)
        scopeCheckbox.focus()
    }

    async openBatch (): Promise<void> {
        const targets = this.editor.includedConnections()
        if (this.batchOpen || !targets.length) { return }
        this.batchOpen = true
        const ref = this.ngbModal.open(MCPBatchModalComponent, {
            size: 'lg',
            backdrop: 'static',
            ariaLabelledBy: 'mcp-batch-title',
        })
        const batch = ref.componentInstance as MCPBatchModalComponent
        batch.connections = targets.map(connection => ({ ...connection }))
        batch.scopeName = this.editor.selectedGroup?.name ?? ''
        batch.catalog = this.catalog
        this.batchModal = ref
        try {
            const enabled = await ref.result
            if (enabled && !this.destroyed) {
                this.editor.applyBatch(targets.map(connection => connection.id), enabled)
            }
        } catch {
            // Cancel, X, and Escape discard only the nested batch draft.
        } finally {
            this.batchModal = null
            this.batchOpen = false
        }
    }
}
