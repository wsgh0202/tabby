import { MCPCatalog, MCPConnection, MCPConnectionCapability, MCPConnectionGrant, MCPGroup, MCPOverrides, MCPPermissions, resolveMCPConnectionCapability, resolveMCPGroupCapability } from './access'
import { MCP_CAPABILITY_LABELS } from './capabilityLabels'

export interface MCPGroupNavigationEntry {
    group: MCPGroup
    depth: number
    hasChildren: boolean
}

export interface MCPPolicyRow {
    id: string
    name: string
    depth: number
    group?: MCPGroup
    connection?: MCPConnection
}

export function getMCPGroupPath (catalog: MCPCatalog, id: string): MCPGroup[] {
    const path: MCPGroup[] = []
    const seen = new Set<string>()
    let group = catalog.groups.find(candidate => candidate.id === id)
    while (group && !seen.has(group.id)) {
        seen.add(group.id)
        path.unshift(group)
        const parentId = group.parentId
        group = catalog.groups.find(candidate => candidate.id === parentId)
    }
    return path
}

/** A draft-only editor. Inclusion and capability overrides are independent axes. */
export class MCPConnectionEditor {
    selectedGroupId = ''
    search = ''
    collapsedNavigation = new Set<string>()
    collapsedRows = new Set<string>()
    private groupsById: Map<string, MCPGroup>
    private paths = new Map<string, MCPGroup[]>()
    private descendants = new Map<string, MCPConnection[]>()

    constructor (public permissions: MCPPermissions, public catalog: MCPCatalog) {
        // A dialog uses a fixed catalog snapshot; index membership once for matrix rendering.
        this.groupsById = new Map(catalog.groups.map(group => [group.id, group]))
        catalog.groups.forEach(group => this.paths.set(group.id, getMCPGroupPath(catalog, group.id)))
        for (const connection of catalog.connections) {
            for (const group of this.groupPath(connection.group)) {
                if (!this.descendants.has(group.id)) { this.descendants.set(group.id, []) }
                this.descendants.get(group.id)!.push(connection)
            }
        }
        const initialGroup = catalog.groups.find(group => !this.parent(group)) ?? catalog.groups.find(group => group.id.length > 0)
        this.selectedGroupId = initialGroup?.id ?? ''
    }

    get selectedGroup (): MCPGroup|undefined {
        return this.groupsById.get(this.selectedGroupId)
    }

    get rootGroups (): MCPGroup[] {
        return this.catalog.groups.filter(group => !this.parent(group))
    }

    parent (group: MCPGroup): MCPGroup|undefined {
        if (!group.parentId || group.parentId === group.id) { return undefined }
        return this.groupsById.get(group.parentId)
    }

    groupPath (id: string): MCPGroup[] {
        return this.paths.get(id) ?? []
    }

    connectionsInGroup (id: string): MCPConnection[] {
        return this.descendants.get(id) ?? []
    }

    included (id: string): boolean {
        return this.grant(id)?.included ?? false
    }

    includedConnections (id = this.selectedGroupId): MCPConnection[] {
        return this.connectionsInGroup(id).filter(connection => this.included(connection.id))
    }

    setIncluded (row: MCPPolicyRow, value: boolean): void {
        const targets = row.group ? this.connectionsInGroup(row.id) : [row.connection!]
        for (const connection of targets) {
            this.mutableGrant(connection.id).included = value
        }
    }

    selected (row: MCPPolicyRow): boolean {
        if (!row.group) { return this.included(row.id) }
        const connections = this.connectionsInGroup(row.id)
        return connections.length > 0 && connections.every(connection => this.included(connection.id))
    }

    partiallySelected (row: MCPPolicyRow): boolean {
        if (!row.group) { return false }
        const connections = this.connectionsInGroup(row.id)
        const count = connections.filter(connection => this.included(connection.id)).length
        return count > 0 && count < connections.length
    }

    get navigation (): MCPGroupNavigationEntry[] {
        const result: MCPGroupNavigationEntry[] = []
        const seen = new Set<string>()
        const query = this.search.trim().toLocaleLowerCase()
        const matching = new Set(this.catalog.groups.filter(group => this.groupPath(group.id).some(parent => parent.name.toLocaleLowerCase().includes(query))).flatMap(group => this.groupPath(group.id).map(parent => parent.id)))
        const visit = (group: MCPGroup, depth: number) => {
            if (seen.has(group.id) || query && !matching.has(group.id)) { return }
            seen.add(group.id)
            const children = this.catalog.groups.filter(candidate => this.parent(candidate)?.id === group.id)
            result.push({ group, depth, hasChildren: children.length > 0 })
            if (query || !this.collapsedNavigation.has(group.id)) {
                children.forEach(child => visit(child, depth + 1))
            }
        }
        this.rootGroups.forEach(group => visit(group, 0))
        // Damaged/orphaned catalogs must remain configurable rather than disappear.
        if (!result.length && !query) { this.catalog.groups.forEach(group => visit(group, 0)) }
        return result
    }

    get rows (): MCPPolicyRow[] {
        const result: MCPPolicyRow[] = []
        const seen = new Set<string>()
        const visit = (group: MCPGroup, depth: number) => {
            if (seen.has(group.id)) { return }
            seen.add(group.id)
            result.push({ id: group.id, name: group.name, depth, group })
            if (this.collapsedRows.has(group.id)) { return }
            this.catalog.groups.filter(child => this.parent(child)?.id === group.id).forEach(child => visit(child, depth + 1))
            this.catalog.connections.filter(connection => connection.group === group.id).forEach(connection => result.push({ id: connection.id, name: connection.name, depth: depth + 1, connection }))
        }
        if (this.selectedGroup) { visit(this.selectedGroup, 0) }
        return result
    }

    effective (row: MCPPolicyRow, capability: MCPConnectionCapability): boolean {
        return row.group
            ? resolveMCPGroupCapability(this.permissions, this.catalog, row.id, capability)
            : resolveMCPConnectionCapability(this.permissions, this.catalog, row.id, capability)
    }

    inherited (row: MCPPolicyRow, capability: MCPConnectionCapability): boolean {
        const parent = row.group ? this.parent(row.group) : this.catalog.groups.find(group => group.id === row.connection?.group)
        return !!parent && !Object.prototype.hasOwnProperty.call(this.overrides(row), capability)
    }

    cycle (row: MCPPolicyRow, capability: MCPConnectionCapability): void {
        const values = this.mutableOverrides(row)
        if (row.group && !this.parent(row.group)) {
            values[capability] = !this.effective(row, capability)
        } else if (!Object.prototype.hasOwnProperty.call(values, capability)) {
            values[capability] = true
        } else if (values[capability]) {
            values[capability] = false
        } else {
            Reflect.deleteProperty(values, capability)
        }
    }

    hasOverrides (id: string): boolean {
        return Object.keys(this.grant(id)?.overrides ?? {}).length > 0
    }

    resetConnection (id: string): void {
        const grant = this.grant(id)
        if (grant) { grant.overrides = {} }
    }

    get canReset (): boolean {
        return this.includedConnections().some(connection => this.hasOverrides(connection.id))
    }

    resetIncluded (): void {
        this.includedConnections().forEach(connection => this.resetConnection(connection.id))
    }

    /** Targets are captured when opening the batch dialog, not recomputed on apply. */
    applyBatch (targets: string[], enabled: MCPConnectionCapability[]): void {
        for (const id of targets) {
            const grant = this.grant(id)
            if (grant) {
                grant.overrides = Object.fromEntries(MCP_CAPABILITY_LABELS.map(capability => [capability.id, enabled.includes(capability.id)]))
            }
        }
    }

    private overrides (row: MCPPolicyRow): MCPOverrides {
        return (row.group ? this.groupOverrides(row.id) : this.grant(row.id)?.overrides) ?? {}
    }

    private mutableOverrides (row: MCPPolicyRow): MCPOverrides {
        if (row.group) {
            return this.groupOverrides(row.id) ?? (this.permissions.groups[row.id] = {})
        }
        return this.mutableGrant(row.id).overrides
    }

    private groupOverrides (id: string): MCPOverrides|undefined {
        return Object.prototype.hasOwnProperty.call(this.permissions.groups, id) ? this.permissions.groups[id] : undefined
    }

    private grant (id: string): MCPConnectionGrant|undefined {
        return Object.prototype.hasOwnProperty.call(this.permissions.connections, id) ? this.permissions.connections[id] : undefined
    }

    private mutableGrant (id: string): MCPConnectionGrant {
        return this.grant(id) ?? (this.permissions.connections[id] = { included: false, overrides: {} })
    }
}
