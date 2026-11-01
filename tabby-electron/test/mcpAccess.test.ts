import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    accessibleCatalog, callMCPTool, canAccessConnection, getMCPIncludedConnections, MCPCatalog,
    newMCPPermissions, readMCPPermissions, resolveMCPConnectionCapability, resolveMCPGroupCapability, validateMCPPermissions,
} from '../src/mcp/access'

const catalog: MCPCatalog = {
    groups: [
        { id: 'a', name: 'A', icon: 'far fa-folder' },
        { id: 'child', name: 'Child', parentId: 'a' },
        { id: 'grandchild', name: 'Grandchild', parentId: 'child' },
        { id: 'b', name: 'B' },
        { id: 'empty', name: 'Empty' },
    ],
    connections: [
        { id: 'a1', name: 'A1', type: 'ssh', group: 'a', icon: '<svg/>', color: 'red', editable: true },
        { id: 'a2', name: 'A2', type: 'ssh', group: 'child' },
        { id: 'a3', name: 'A3', type: 'ssh', group: 'grandchild' },
        { id: 'b1', name: 'B1', type: 'ssh', group: 'b' },
    ],
}

function permissionsWithSelection () {
    const permissions = newMCPPermissions()
    permissions.capabilities = ['connection_operations']
    permissions.connections.a1 = { included: true, overrides: {} }
    permissions.connections.a2 = { included: true, overrides: {} }
    permissions.connections.a3 = { included: true, overrides: {} }
    return permissions
}

test('new tokens deny every operation and connection', () => {
    const permissions = newMCPPermissions()
    assert.deepEqual(accessibleCatalog(permissions, catalog), { groups: [], connections: [] })
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a1', 'view_config'), false)
    assert.throws(() => callMCPTool(permissions, catalog, 'list_connections', {}), /denied/)
    validateMCPPermissions(permissions)
})

test('configuration reads accept valid token metadata and reject unsupported permission data without changing it', () => {
    const permissions = permissionsWithSelection()
    const entry = { ...permissions, id: 'token', name: 'Agent', preview: 'abcd…1234' }
    assert.deepEqual(readMCPPermissions(entry), permissions)
    const unsupported = { id: 'token', name: 'Agent', tools: ['list_connections'], groups: { mode: 'all', ids: [] }, connections: { mode: 'all', ids: [] } }
    const original = JSON.stringify(unsupported)
    for (const value of [undefined, null, [], unsupported,
        { ...entry, capabilities: 'connection_operations' },
        { ...entry, connections: { a1: { included: true, overrides: { access: null } } } },
    ]) {
        assert.equal(readMCPPermissions(value), null)
    }
    assert.equal(JSON.stringify(unsupported), original, 'reading must not convert or overwrite existing configuration')
})

test('selection determines discovery independently from configuration and terminal permissions', () => {
    const permissions = permissionsWithSelection()
    permissions.connections.a1.included = false
    permissions.connections.a1.overrides = { view_config: true, access: true }
    assert.equal(canAccessConnection(permissions, catalog.connections[0]), false)
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a1', 'access'), true, 'the editor still resolves retained overrides')
    assert.deepEqual(callMCPTool(permissions, catalog, 'list_connections', {}).map(connection => connection.id), ['a2', 'a3'])
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a2', 'view_config'), false, 'selected metadata is discoverable without configuration permission')
    permissions.capabilities = []
    assert.equal(canAccessConnection(permissions, catalog.connections[1]), false)
    assert.deepEqual(accessibleCatalog(permissions, catalog), { groups: [], connections: [] })
    assert.equal(getMCPIncludedConnections(permissions, catalog).length, 2, 'the editor keeps selection when the package is disabled')
})

test('discovery exposes only selected connections and necessary ancestor groups', () => {
    const permissions = newMCPPermissions()
    permissions.capabilities = ['connection_operations']
    permissions.connections.a3 = { included: true, overrides: {} }
    assert.deepEqual(callMCPTool(permissions, catalog, 'list_connection_groups', {}), [
        { id: 'a', name: 'A' },
        { id: 'child', name: 'Child', parentId: 'a' },
        { id: 'grandchild', name: 'Grandchild', parentId: 'child' },
    ])
    assert.deepEqual(callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'a' }), [], 'a visible ancestor does not reveal unselected direct connections')
    assert.deepEqual(callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'grandchild' }), [{ id: 'a3', name: 'A3', type: 'ssh', group: 'grandchild' }])
    assert.throws(() => callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'empty' }), /denied/)
    assert.throws(() => callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'unknown' }), /denied/)
})

test('directory results omit presentation data and reject malformed arguments', () => {
    const permissions = permissionsWithSelection()
    assert.deepEqual(callMCPTool(permissions, catalog, 'list_group_connections', { groupId: 'a' }), [{ id: 'a1', name: 'A1', type: 'ssh', group: 'a' }])
    for (const args of [{}, { groupId: 1 }, { groupId: 'a', connectionId: 'b1' }]) {
        assert.throws(() => callMCPTool(permissions, catalog, 'list_group_connections', args))
    }
    assert.throws(() => callMCPTool(permissions, catalog, 'list_connections', { groupId: 'a' }), /arguments/)
    assert.throws(() => callMCPTool(permissions, catalog, 'unknown', {}), /Unknown/)
})

test('each capability inherits through the direct group and its direct parent', () => {
    const permissions = permissionsWithSelection()
    permissions.groups.a = { view_config: true, edit_config: false, access: true, upload: true, download: true }
    permissions.groups.child = { access: false, upload: false }
    permissions.groups.grandchild = { download: false }
    assert.equal(resolveMCPGroupCapability(permissions, catalog, 'child', 'view_config'), true)
    assert.equal(resolveMCPGroupCapability(permissions, catalog, 'grandchild', 'access'), false)
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a3', 'view_config'), true)
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a3', 'access'), false)
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a3', 'upload'), false)
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a3', 'download'), false)
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'b1', 'download'), false)
    assert.equal(resolveMCPGroupCapability(permissions, catalog, 'a', 'edit_config'), false)
})

test('explicit false survives parent edits and removing an override restores inheritance', () => {
    const permissions = permissionsWithSelection()
    permissions.groups.a = { access: true }
    permissions.connections.a2.overrides = { access: false, upload: true }
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a2', 'access'), false)
    permissions.groups.child = { access: true, upload: false }
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a2', 'access'), false)
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a2', 'upload'), true)
    delete permissions.connections.a2.overrides.access
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a2', 'access'), true)
    delete permissions.groups.child.access
    permissions.groups.a.access = false
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'a2', 'access'), false)
})

test('templates apply to new connections without automatically including them', () => {
    const permissions = permissionsWithSelection()
    permissions.groups.child = { view_config: true, upload: true }
    const future = { id: 'future', name: 'Future', type: 'ssh', group: 'child' }
    const expanded = { ...catalog, connections: [...catalog.connections, future] }
    assert.equal(resolveMCPConnectionCapability(permissions, expanded, 'future', 'upload'), true)
    assert.equal(canAccessConnection(permissions, future), false)
    assert.ok(!getMCPIncludedConnections(permissions, expanded).some(connection => connection.id === 'future'))
})

test('selection counts include descendants and ignore permission overrides', () => {
    const permissions = permissionsWithSelection()
    permissions.connections.a2.included = false
    permissions.connections.a2.overrides = { access: true }
    permissions.groups.a = { access: true }
    assert.deepEqual(getMCPIncludedConnections(permissions, catalog, 'a').map(connection => connection.id), ['a1', 'a3'])
    assert.deepEqual(getMCPIncludedConnections(permissions, catalog, 'child').map(connection => connection.id), ['a3'])
    assert.deepEqual(getMCPIncludedConnections(permissions, catalog, 'empty'), [])
    assert.deepEqual(getMCPIncludedConnections(permissions, catalog, 'missing'), [])
})

test('unknown groups, missing parents and cycles fail closed even with explicit grants', () => {
    const permissions = permissionsWithSelection()
    permissions.groups.a = { access: true }
    permissions.connections.a1.overrides = { access: true }
    for (const groups of [
        [{ id: 'a', name: 'A', parentId: 'missing' }],
        [{ id: 'a', name: 'A', parentId: 'child' }, { id: 'child', name: 'Child', parentId: 'a' }],
        [{ id: 'a', name: 'A', parentId: 'a' }],
        [],
    ]) {
        const invalid = { ...catalog, groups }
        assert.equal(resolveMCPGroupCapability(permissions, invalid, 'a', 'access'), false)
        assert.equal(resolveMCPConnectionCapability(permissions, invalid, 'a1', 'access'), false)
        assert.deepEqual(accessibleCatalog(permissions, invalid), { groups: [], connections: [] })
        assert.deepEqual(getMCPIncludedConnections(permissions, invalid, 'a'), [])
    }
    assert.equal(resolveMCPConnectionCapability(permissions, catalog, 'missing', 'access'), false)
})

test('validation rejects unknown capabilities, malformed records and prototype pollution keys', () => {
    const invalid: unknown[] = [
        null, [], {},
        { ...newMCPPermissions(), capabilities: ['unknown'] },
        { ...newMCPPermissions(), capabilities: ['connection_operations', 'connection_operations'] },
        { ...newMCPPermissions(), groups: [] },
        { ...newMCPPermissions(), groups: { a: { access: null } } },
        { ...newMCPPermissions(), groups: { a: { invented: true } } },
        { ...newMCPPermissions(), groups: JSON.parse('{"__proto__":{"access":true}}') },
        { ...newMCPPermissions(), groups: { constructor: { access: true } } },
        { ...newMCPPermissions(), connections: { a1: { included: 'true', overrides: {} } } },
        { ...newMCPPermissions(), connections: { a1: { included: true, overrides: { access: 1 } } } },
        { ...newMCPPermissions(), connections: { a1: { included: true, overrides: {}, extra: true } } },
        { ...newMCPPermissions(), tools: [] },
    ]
    for (const value of invalid) {
        assert.throws(() => validateMCPPermissions(value as any), undefined, JSON.stringify(value))
    }
    validateMCPPermissions(permissionsWithSelection())
    validateMCPPermissions({ capabilities: [], groups: Object.create(null), connections: Object.create(null) })
})
