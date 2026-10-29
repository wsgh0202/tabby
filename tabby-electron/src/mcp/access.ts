/** Public MCP records deliberately omit profile options, defaults and credentials. */
export interface MCPConnection {
    id: string
    name: string
    type: string
    group: string
}

export interface MCPGroup {
    id: string
    name: string
}

export interface MCPCatalog {
    groups: MCPGroup[]
    connections: MCPConnection[]
}

export const MCP_TOOLS = [
    { name: 'list_connection_groups', description: 'List accessible connection groups.' },
    { name: 'list_connections', description: 'List all accessible connections.' },
    { name: 'list_group_connections', description: 'List accessible connections in a group.' },
] as const

export interface MCPPermissions {
    tools: string[]
    connections: { mode: 'all'|'custom', ids: string[] }
    groups: { mode: 'all'|'custom', ids: string[] }
}

export function newMCPPermissions (): MCPPermissions {
    return {
        tools: [],
        connections: { mode: 'custom', ids: [] },
        groups: { mode: 'custom', ids: [] },
    }
}

export function validateMCPPermissions (permissions: MCPPermissions): void {
    if (!Array.isArray(permissions.tools) || permissions.tools.some(name => !MCP_TOOLS.some(tool => tool.name === name))) {
        throw new Error('Unknown MCP tool')
    }
    for (const scope of [permissions.connections, permissions.groups]) {
        if (!['all', 'custom'].includes(scope.mode) || !Array.isArray(scope.ids) || scope.ids.some(id => typeof id !== 'string')) {
            throw new Error('Invalid MCP access scope')
        }
    }
}

export function canAccessConnection (permissions: MCPPermissions, connection: MCPConnection): boolean {
    return permissions.connections.mode === 'all'
        || permissions.connections.ids.includes(connection.id)
        || permissions.groups.mode === 'all'
        || permissions.groups.ids.includes(connection.group)
}

export function accessibleCatalog (permissions: MCPPermissions, catalog: MCPCatalog): MCPCatalog {
    const connections = catalog.connections.filter(connection => canAccessConnection(permissions, connection))
    const visibleGroups = new Set(connections.map(connection => connection.group))
    return {
        connections,
        groups: catalog.groups.filter(group => permissions.groups.mode === 'all'
            || permissions.groups.ids.includes(group.id) || visibleGroups.has(group.id)),
    }
}

export function callMCPTool (permissions: MCPPermissions, catalog: MCPCatalog, name: string, args: Record<string, unknown>): MCPConnection[]|MCPGroup[] {
    if (!permissions.tools.includes(name)) {
        throw new Error('Tool access denied')
    }
    const visible = accessibleCatalog(permissions, catalog)
    if (name === 'list_group_connections') {
        if (Object.keys(args).some(key => key !== 'groupId') || typeof args.groupId !== 'string') {
            throw new Error('Expected a groupId string')
        }
        // Do not distinguish an unknown group from a group outside this token's scope.
        if (!visible.groups.some(group => group.id === args.groupId)) {
            throw new Error('Group access denied')
        }
        return visible.connections.filter(connection => connection.group === args.groupId)
    }
    if (Object.keys(args).length) {
        throw new Error('This tool does not accept arguments')
    }
    if (name === 'list_connection_groups') {
        return visible.groups
    }
    if (name === 'list_connections') {
        return visible.connections
    }
    throw new Error('Unknown MCP tool')
}
