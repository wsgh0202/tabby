import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { MCPCatalog, MCPConnection, MCPConnectionCapability } from '../mcp/access'
import { MCP_CAPABILITY_LABELS } from '../mcp/capabilityLabels'
import { getMCPGroupPath } from '../mcp/connectionEditor'

/** @hidden */
@Component({
    templateUrl: './mcpBatchModal.component.pug',
    styleUrls: ['./mcpBatchModal.component.scss'],
})
export class MCPBatchModalComponent {
    @Input() connections: MCPConnection[] = []
    @Input() catalog: MCPCatalog = { groups: [], connections: [] }
    @Input() scopeName = ''
    capabilities = MCP_CAPABILITY_LABELS
    enabled: MCPConnectionCapability[] = []

    constructor (public modal: NgbActiveModal) { }

    toggle (id: MCPConnectionCapability, value: boolean): void {
        this.enabled = value ? [...this.enabled.filter(capability => capability !== id), id] : this.enabled.filter(capability => capability !== id)
    }

    connectionPath (connection: MCPConnection): string {
        return [...getMCPGroupPath(this.catalog, connection.group).map(group => group.name), connection.name].join(' / ')
    }
}
