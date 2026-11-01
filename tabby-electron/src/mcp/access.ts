import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'

/** Catalog presentation fields are local UI data; tool results select public fields explicitly. */
export interface MCPConnection {
    id: string
    name: string
    type: string
    group: string
    icon?: string|null
    color?: string|null
    editable?: boolean
}

export interface MCPGroup {
    id: string
    name: string
    parentId?: string|null
    icon?: string|null
    color?: string|null
}

export interface MCPCatalog {
    groups: MCPGroup[]
    connections: MCPConnection[]
}

// Named permission types keep the model extensible without spreading string literals.
// eslint-disable-next-line @typescript-eslint/no-type-alias
export type MCPGlobalCapability = 'connection_operations'
export type MCPConnectionCapability = 'view_config'|'edit_config'|'access'|'upload'|'download'
// eslint-disable-next-line @typescript-eslint/no-type-alias
export type MCPOverrides = Partial<Record<MCPConnectionCapability, boolean>>

export interface MCPConnectionGrant {
    included: boolean
    overrides: MCPOverrides
}

/** Scope selection and operation grants are intentionally independent. */
export interface MCPPermissions {
    capabilities: MCPGlobalCapability[]
    groups: Record<string, MCPOverrides>
    connections: Record<string, MCPConnectionGrant>
}

const CONNECTION_CAPABILITIES: MCPConnectionCapability[] = ['view_config', 'edit_config', 'access', 'upload', 'download']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function newMCPPermissions (): MCPPermissions {
    return { capabilities: [], groups: {}, connections: {} }
}

function isRecord (value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false }
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function ownValue <T> (record: Record<string, T>, key: string): T|undefined {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

function validOverrides (value: unknown): boolean {
    return isRecord(value) && Object.entries(value).every(([key, enabled]) =>
        CONNECTION_CAPABILITIES.includes(key as MCPConnectionCapability) && typeof enabled === 'boolean')
}

export function validateMCPPermissions (permissions: MCPPermissions): void {
    if (!isRecord(permissions) || Object.keys(permissions).some(key => !['capabilities', 'groups', 'connections'].includes(key))) {
        throw new Error(_('Invalid MCP access scope'))
    }
    if (!Array.isArray(permissions.capabilities)
        || permissions.capabilities.some((capability: unknown) => capability !== 'connection_operations')
        || new Set(permissions.capabilities).size !== permissions.capabilities.length) {
        throw new Error(_('Invalid MCP capabilities'))
    }
    if (!isRecord(permissions.groups) || !isRecord(permissions.connections)) {
        throw new Error(_('Invalid MCP access scope'))
    }
    for (const [id, overrides] of Object.entries(permissions.groups)) {
        if (!id || UNSAFE_KEYS.has(id) || !validOverrides(overrides)) {
            throw new Error(_('Invalid MCP access scope'))
        }
    }
    for (const [id, grant] of Object.entries(permissions.connections)) {
        if (!id || UNSAFE_KEYS.has(id) || !isRecord(grant)
            || Object.keys(grant).some(key => !['included', 'overrides'].includes(key))
            || typeof grant.included !== 'boolean' || !validOverrides(grant.overrides)) {
            throw new Error(_('Invalid MCP access scope'))
        }
    }
}

/** A malformed ancestry never becomes a new root with broader permissions. */
function groupAncestry (catalog: MCPCatalog, groupId: string): MCPGroup[]|null {
    const result: MCPGroup[] = []
    const seen = new Set<string>()
    let id: string|null|undefined = groupId
    while (id) {
        if (seen.has(id)) { return null }
        seen.add(id)
        const currentId = id
        const group = catalog.groups.find(item => item.id === currentId)
        if (!group) { return null }
        result.push(group)
        id = group.parentId
    }
    return result.length ? result : null
}

/** Resolution is also used by the editor, so it does not apply scope/global gates. */
export function resolveMCPGroupCapability (permissions: MCPPermissions, catalog: MCPCatalog, groupId: string, capability: MCPConnectionCapability): boolean {
    const ancestry = groupAncestry(catalog, groupId)
    if (!ancestry) { return false }
    for (const group of ancestry) {
        const overrides = ownValue(permissions.groups, group.id)
        const value = overrides && ownValue(overrides, capability)
        if (typeof value === 'boolean') { return value }
    }
    return false
}

export function resolveMCPConnectionCapability (permissions: MCPPermissions, catalog: MCPCatalog, connectionId: string, capability: MCPConnectionCapability): boolean {
    const connection = catalog.connections.find(item => item.id === connectionId)
    if (!connection || !groupAncestry(catalog, connection.group)) { return false }
    const grant = ownValue(permissions.connections, connection.id)
    const value = grant && ownValue(grant.overrides, capability)
    return typeof value === 'boolean' ? value : resolveMCPGroupCapability(permissions, catalog, connection.group, capability)
}

/** The UI counts selected connections even while their capability package is disabled. */
export function getMCPIncludedConnections (permissions: MCPPermissions, catalog: MCPCatalog, groupId?: string): MCPConnection[] {
    return catalog.connections.filter(connection => ownValue(permissions.connections, connection.id)?.included === true
        && (groupId === undefined || groupAncestry(catalog, connection.group)?.some(group => group.id === groupId)))
}

export function canAccessConnection (permissions: MCPPermissions, connection: MCPConnection): boolean {
    return permissions.capabilities.includes('connection_operations')
        && ownValue(permissions.connections, connection.id)?.included === true
}

/** Only selected connections and the ancestry needed to locate them are discoverable. */
export function accessibleCatalog (permissions: MCPPermissions, catalog: MCPCatalog): MCPCatalog {
    const connections = catalog.connections.filter(connection => canAccessConnection(permissions, connection)
        && groupAncestry(catalog, connection.group))
    const visibleGroups = new Set(connections.flatMap(connection => groupAncestry(catalog, connection.group)!.map(group => group.id)))
    return { connections, groups: catalog.groups.filter(group => visibleGroups.has(group.id)) }
}

export function callMCPTool (permissions: MCPPermissions, catalog: MCPCatalog, name: string, args: Record<string, unknown>): MCPConnection[]|MCPGroup[] {
    if (!permissions.capabilities.includes('connection_operations')) { throw new Error('Tool access denied') }
    const visible = accessibleCatalog(permissions, catalog)
    const publicConnections = (connections: MCPConnection[]) => connections.map(({ id, name: connectionName, type, group }) => ({ id, name: connectionName, type, group }))
    if (name === 'list_group_connections') {
        if (Object.keys(args).some(key => key !== 'groupId') || typeof args.groupId !== 'string') {
            throw new Error('Expected a groupId string')
        }
        // Unknown and inaccessible groups produce the same error.
        if (!visible.groups.some(group => group.id === args.groupId)) { throw new Error('Group access denied') }
        return publicConnections(visible.connections.filter(connection => connection.group === args.groupId))
    }
    if (Object.keys(args).length) {
        throw new Error('This tool does not accept arguments')
    }
    if (name === 'list_connection_groups') {
        return visible.groups.map(({ id, name: groupName, parentId }) => ({ id, name: groupName, ...(parentId ? { parentId } : {}) }))
    }
    if (name === 'list_connections') {
        return publicConnections(visible.connections)
    }
    throw new Error('Unknown MCP tool')
}
