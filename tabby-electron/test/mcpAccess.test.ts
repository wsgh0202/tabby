import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessibleCatalog, callMCPTool, MCP_TOOLS, newMCPPermissions } from '../src/mcp/access'

const catalog = {
    groups: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'empty', name: 'Empty' }],
    connections: [
        { id: 'a1', name: 'A1', type: 'ssh', group: 'a' },
        { id: 'a2', name: 'A2', type: 'ssh', group: 'a' },
        { id: 'b1', name: 'B1', type: 'ssh', group: 'b' },
    ],
}

test('new tokens deny all tools and connections', () => {
    const permissions = newMCPPermissions()
    assert.deepEqual(accessibleCatalog(permissions, catalog), { groups: [], connections: [] })
    assert.throws(() => callMCPTool(permissions, catalog, 'list_connections', {}), /denied/)
})

test('an individual connection reveals its group but not its siblings', () => {
    const permissions = newMCPPermissions()
    permissions.tools = MCP_TOOLS.map(tool => tool.name)
    permissions.connections.ids = ['a1']
    assert.deepEqual(callMCPTool(permissions, catalog, 'list_connection_groups', {}), [catalog.groups[0]])
    assert.deepEqual(callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'a' }), [catalog.connections[0]])
    assert.throws(() => callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'b' }), /denied/)
    assert.throws(() => callMCPTool(permissions, catalog, 'list_connections', { groupId: 'b' }), /arguments/)
})

test('group grants include future connections and empty groups', () => {
    const permissions = newMCPPermissions()
    permissions.groups.ids = ['a', 'empty']
    const expanded = { ...catalog, connections: [...catalog.connections, { id: 'a3', name: 'A3', type: 'ssh', group: 'a' }] }
    assert.deepEqual(accessibleCatalog(permissions, expanded).connections.map(connection => connection.id), ['a1', 'a2', 'a3'])
    assert.deepEqual(accessibleCatalog(permissions, expanded).groups.map(group => group.id), ['a', 'empty'])
    permissions.groups.ids = []
    permissions.connections.ids = ['a1']
    assert.equal(accessibleCatalog(permissions, expanded).connections.length, 1)
})

test('connections and groups have separate all/custom selections', () => {
    const permissions = newMCPPermissions()
    permissions.connections.mode = 'all'
    assert.equal(accessibleCatalog(permissions, catalog).connections.length, 3)
    assert.equal(accessibleCatalog(permissions, catalog).groups.length, 2)
    permissions.connections.mode = 'custom'
    permissions.groups.mode = 'all'
    assert.deepEqual(accessibleCatalog(permissions, catalog), catalog)
})

test('malformed group arguments and removed tool grants are rejected', () => {
    const permissions = newMCPPermissions()
    permissions.tools = ['list_group_connections']
    permissions.groups.mode = 'all'
    for (const args of [{}, { groupId: 1 }, { groupId: 'a', connectionId: 'b1' }, { groupId: 'unknown' }]) {
        assert.throws(() => callMCPTool(permissions, catalog, 'list_group_connections', args))
    }
    permissions.tools = []
    assert.throws(() => callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'a' }), /denied/)
})
