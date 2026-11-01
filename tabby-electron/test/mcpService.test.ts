import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { AsyncSubject, Subject } from 'rxjs'
import { MCPService } from '../src/services/mcp.service'
import { newMCPPermissions } from '../src/mcp/access'
import { MCP_TOKEN_ID_PREFIX, hashMCPToken } from '../src/mcp/tokens'

function setup (isMainWindow = true) {
    const windowEvents = new EventTarget()
    globalThis.window = windowEvents as any
    const ready = new AsyncSubject<boolean>()
    const changed = new Subject<void>()
    const config = {
        store: { mcp: { enabled: false, port: null, lastRandomPort: null, tokens: [] as any[] } },
        ready$: ready,
        changed$: changed,
        saves: 0,
        fail: false,
        save: async () => {
            if (config.fail) { throw new Error('Save failed') }
            config.saves++
            changed.next()
        },
    }
    const secrets: any[] = []
    const vault = {
        store: {},
        loads: 0,
        isEnabled: () => true,
        isOpen: () => true,
        getCacheRevision: () => vault.store,
        load: async () => { vault.loads++; return { config: {}, secrets } },
        addSecret: async secret => {
            const snapshot = [...secrets]
            await new Promise<void>(resolve => setImmediate(resolve))
            secrets.splice(0, secrets.length, ...snapshot, secret)
            vault.store = {}
        },
        removeSecret: async (_type, key) => {
            const snapshot = secrets.filter(secret => secret.key.id !== key.id)
            await new Promise<void>(resolve => setImmediate(resolve))
            secrets.splice(0, secrets.length, ...snapshot)
            vault.store = {}
        },
    }
    const profiles = {
        getConfigProxyForProfile: profile => ({ ...profile, icon: null, color: null }),
        getProfileGroups: async options => {
            assert.deepEqual(options, { includeProfiles: true, includeNonUserGroup: true })
            return [{
                id: 'group', name: 'Group', defaults: { password: 'secret' },
                profiles: [
                    { id: 'one', name: 'One', type: 'ssh', options: { password: 'secret' } },
                    { id: 'template', name: 'Template', type: 'ssh', isTemplate: true },
                    { name: 'No ID', type: 'local' },
                ],
            }]
        },
    }
    const ipcRenderer = new EventEmitter()
    const disposedTokens: string[] = []
    const connections = {
        callOperation: async () => { throw new Error('Unexpected connection operation') },
        disposeToken: id => { disposedTokens.push(id) },
        disposeAll: () => undefined,
    }
    const service = new MCPService(config as any, profiles as any, vault as any, { isMainWindow } as any, { ipcRenderer } as any, connections as any)
    ready.next(true)
    ready.complete()
    const cleanup = async () => {
        config.store.mcp.enabled = false
        await service.refresh()
        windowEvents.dispatchEvent(new Event('beforeunload'))
    }
    return { service, config, vault, secrets, ipcRenderer, disposedTokens, cleanup }
}

test('service persists an automatic port and reuses it across serialized restarts', async () => {
    const { service, config, cleanup } = setup()
    try {
        config.store.mcp.enabled = true
        await service.refresh()
        const port = config.store.mcp.lastRandomPort
        assert.ok(port)
        assert.equal(service.address, `http://127.0.0.1:${port}/mcp`)
        assert.equal(config.saves, 1)
        config.store.mcp.enabled = false
        await service.refresh()
        assert.equal(service.address, null)
        config.store.mcp.enabled = true
        await Promise.all([service.refresh(), service.refresh(), service.refresh()])
        assert.equal(service.address, `http://127.0.0.1:${port}/mcp`)
        assert.equal(config.saves, 1)
    } finally { await cleanup() }
})

test('secondary windows start listening only after becoming the main window', async () => {
    const { service, config, ipcRenderer, cleanup } = setup(false)
    try {
        config.store.mcp.enabled = true
        await service.refresh()
        assert.equal(service.address, null)
        ipcRenderer.emit('host:became-main-window')
        await service.refresh()
        assert.ok(service.address)
    } finally { await cleanup() }
})

test('catalog exposes only stable connection metadata, including provider groups', async () => {
    const { service, cleanup } = setup()
    try {
        assert.deepEqual(await service.getCatalog(), {
            groups: [{ id: 'group', name: 'Group', parentId: null, icon: null, color: null }],
            connections: [{ id: 'one', name: 'One', type: 'ssh', group: 'group', icon: null, color: null, editable: true }],
        })
    } finally { await cleanup() }
})

test('failed token persistence rolls back both metadata and vault credentials', async () => {
    const { service, config, secrets, cleanup } = setup()
    try {
        config.fail = true
        await assert.rejects(service.createToken('Agent', newMCPPermissions()), /Save failed/)
        assert.deepEqual(config.store.mcp.tokens, [])
        assert.deepEqual(secrets, [])
    } finally { await cleanup() }
})

test('concurrent token creation does not overwrite vault snapshots', async () => {
    const { service, config, secrets, cleanup } = setup()
    try {
        const tokens = await Promise.all([
            service.createToken('Agent A', newMCPPermissions()),
            service.createToken('Agent B', newMCPPermissions()),
        ])
        assert.equal(config.store.mcp.tokens.length, 2)
        assert.deepEqual(secrets.map(secret => secret.key.id).sort(), tokens.map(token => MCP_TOKEN_ID_PREFIX + hashMCPToken(token)).sort())
    } finally { await cleanup() }
})

test('concurrent creation and revocation preserve the new credential', async () => {
    const { service, config, secrets, cleanup } = setup()
    try {
        await service.createToken('Old agent', newMCPPermissions())
        const oldId = config.store.mcp.tokens[0].id
        const [token] = await Promise.all([
            service.createToken('New agent', newMCPPermissions()),
            service.removeToken(oldId),
        ])
        assert.equal(config.store.mcp.tokens.length, 1)
        assert.deepEqual(secrets.map(secret => secret.key.id), [MCP_TOKEN_ID_PREFIX + hashMCPToken(token)])
    } finally { await cleanup() }
})

test('a failed token transaction does not block later mutations', async () => {
    const { service, config, secrets, cleanup } = setup()
    try {
        config.fail = true
        await assert.rejects(service.createToken('Failed', newMCPPermissions()), /Save failed/)
        config.fail = false
        await service.createToken('Working', newMCPPermissions())
        assert.deepEqual(config.store.mcp.tokens.map(token => token.name), ['Working'])
        assert.equal(secrets.length, 1)
    } finally { await cleanup() }
})

test('mixed invalid token records survive valid edits, revocation and failed creation', async () => {
    const { service, config, secrets, cleanup } = setup()
    try {
        await service.createToken('Current agent', newMCPPermissions())
        const target = config.store.mcp.tokens[0]
        const invalid = [null, {}, { id: target.id, name: 2 }]
        const legacy = { id: 'legacy', name: 'Old agent', tools: ['list_connections'], groups: { mode: 'all', ids: [] }, connections: { mode: 'all', ids: [] } }
        config.store.mcp.tokens = [...invalid, legacy, target]
        await service.updateToken(target.id, newMCPPermissions(), 'Renamed')
        assert.deepEqual(config.store.mcp.tokens.slice(0, invalid.length), invalid)
        assert.equal(config.store.mcp.tokens[4].name, 'Renamed')
        await service.updateToken(legacy.id, newMCPPermissions(), 'Reconfigured')
        assert.deepEqual(config.store.mcp.tokens[3].capabilities, [])
        assert.deepEqual(config.store.mcp.tokens[3].connections, {})
        const snapshot = JSON.stringify(config.store.mcp.tokens)
        config.fail = true
        await assert.rejects(service.createToken('Failed', newMCPPermissions()), /Save failed/)
        assert.equal(JSON.stringify(config.store.mcp.tokens), snapshot)
        assert.equal(secrets.length, 1)
        config.fail = false
        await service.removeToken(target.id)
        assert.deepEqual(config.store.mcp.tokens.slice(0, invalid.length), invalid)
        assert.equal(config.store.mcp.tokens.length, 4)
        assert.deepEqual(secrets, [])
    } finally { await cleanup() }
})

test('non-array token collections reject mutations before creating or removing vault credentials', async () => {
    const { service, config, vault, secrets, cleanup } = setup()
    let removals = 0
    const remove = vault.removeSecret
    vault.removeSecret = async (...args) => { removals++; await remove(...args) }
    try {
        for (const invalid of [null, {}, 'tokens']) {
            config.store.mcp.tokens = invalid as any
            await assert.rejects(service.createToken('Agent', newMCPPermissions()), /MCP token records are invalid/)
            await assert.rejects(service.updateToken('id', newMCPPermissions()), /MCP token records are invalid/)
            await assert.rejects(service.removeToken('id'), /MCP token records are invalid/)
            assert.equal(config.store.mcp.tokens, invalid)
        }
        assert.equal(config.saves, 0)
        assert.equal(removals, 0)
        assert.deepEqual(secrets, [])
    } finally { await cleanup() }
})

test('creation removes its new credential if token records become invalid while the vault is saving', async () => {
    const { service, config, vault, secrets, cleanup } = setup()
    const add = vault.addSecret
    vault.addSecret = async secret => { await add(secret); config.store.mcp.tokens = null as any }
    try {
        await assert.rejects(service.createToken('Agent', newMCPPermissions()), /MCP token records are invalid/)
        assert.equal(config.store.mcp.tokens, null)
        assert.deepEqual(secrets, [])
        assert.equal(config.saves, 0)
    } finally { await cleanup() }
})

test('created, edited and revoked tokens affect authenticated HTTP requests', async () => {
    const { service, config, secrets, cleanup } = setup()
    try {
        const permissions = newMCPPermissions()
        permissions.capabilities = ['connection_operations']
        permissions.connections.one = { included: true, overrides: { view_config: true } }
        const token = await service.createToken('Agent', permissions)
        assert.equal(secrets.length, 1)
        config.store.mcp.enabled = true
        await service.refresh()
        const call = () => fetch(service.address!, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        assert.deepEqual((await (await call()).json()).result.tools.map(tool => tool.name).sort(), [
            'get_connection_config', 'list_connection_groups', 'list_connections', 'list_group_connections',
        ])
        await service.updateToken(config.store.mcp.tokens[0].id, newMCPPermissions())
        assert.equal((await (await call()).json()).result.tools.length, 0)
        await service.removeToken(config.store.mcp.tokens[0].id)
        assert.equal((await call()).status, 401)
        assert.equal(secrets.length, 0)
    } finally { await cleanup() }
})

test('token display names are optional and roll back with permission changes on save failure', async () => {
    const { service, config, cleanup } = setup()
    try {
        await service.createToken('', newMCPPermissions())
        const original = config.store.mcp.tokens[0]
        await service.updateToken(original.id, newMCPPermissions(), ' Renamed ')
        assert.equal(config.store.mcp.tokens[0].name, 'Renamed')
        assert.equal(config.store.mcp.tokens[0].preview, original.preview)
        config.fail = true
        await assert.rejects(service.updateToken(original.id, newMCPPermissions(), ''), /Save failed/)
        assert.equal(config.store.mcp.tokens[0].name, 'Renamed')
        config.fail = false
        await service.updateToken(original.id, newMCPPermissions(), '')
        assert.equal(config.store.mcp.tokens[0].name, '')
        assert.equal(config.store.mcp.tokens[0].preview, original.preview)
    } finally { await cleanup() }
})

test('committed permission edits and revocation dispose token-owned connections', async () => {
    const { service, config, secrets, disposedTokens, cleanup } = setup()
    try {
        await service.createToken('Agent', newMCPPermissions())
        const id = config.store.mcp.tokens[0].id
        await service.updateToken(id, newMCPPermissions())
        assert.deepEqual(disposedTokens, [id])
        config.fail = true
        await assert.rejects(service.updateToken(id, newMCPPermissions()), /Save failed/)
        assert.deepEqual(disposedTokens, [id], 'a failed edit keeps the existing policy and sessions')
        await assert.rejects(service.removeToken(id), /Save failed/)
        assert.deepEqual(disposedTokens, [id, id], 'revocation closes connections even when metadata persistence fails')
        assert.deepEqual(secrets, [], 'a failed metadata write does not restore the revoked credential')
    } finally { await cleanup() }
})

test('service reuses credential hashes while live policy edits still change HTTP authorization', async () => {
    const { service, config, vault, cleanup } = setup()
    try {
        const permissions = newMCPPermissions()
        permissions.capabilities = ['connection_operations']
        permissions.connections.one = { included: true, overrides: { access: true } }
        const token = await service.createToken('Agent', permissions)
        config.store.mcp.enabled = true
        await service.refresh()
        const call = () => fetch(service.address!, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        const responses = await Promise.all(Array.from({ length: 8 }, async () => (await (await call()).json()).result.tools))
        assert.ok(responses.every(tools => tools.some(tool => tool.name === 'open_connection')))
        assert.equal(vault.loads, 1, 'parallel SDK authorization checks share one vault decryption')
        await service.updateToken(config.store.mcp.tokens[0].id, newMCPPermissions())
        assert.equal((await (await call()).json()).result.tools.length, 0)
        assert.equal(vault.loads, 1, 'saving policy metadata does not change the encrypted vault revision')
    } finally { await cleanup() }
})

test('deleting a credential in the vault page invalidates the service hash cache', async () => {
    const { service, config, vault, secrets, cleanup } = setup()
    try {
        const token = await service.createToken('Agent', newMCPPermissions())
        config.store.mcp.enabled = true
        await service.refresh()
        const call = () => fetch(service.address!, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        assert.equal((await call()).status, 200)
        assert.equal(vault.loads, 1)
        secrets.splice(0)
        vault.store = {}
        assert.equal((await call()).status, 401)
        assert.equal(vault.loads, 2)
    } finally { await cleanup() }
})
