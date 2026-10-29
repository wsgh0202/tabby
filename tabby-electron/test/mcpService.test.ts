import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { AsyncSubject, Subject } from 'rxjs'
import { MCPService } from '../src/services/mcp.service'
import { newMCPPermissions } from '../src/mcp/access'

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
        isEnabled: () => true,
        isOpen: () => true,
        load: async () => ({ config: {}, secrets }),
        addSecret: async secret => { secrets.push(secret) },
        removeSecret: async (_type, key) => {
            const index = secrets.findIndex(secret => secret.key.id === key.id)
            if (index !== -1) { secrets.splice(index, 1) }
        },
    }
    const profiles = {
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
    const service = new MCPService(config as any, profiles as any, vault as any, { isMainWindow } as any, { ipcRenderer } as any)
    ready.next(true)
    ready.complete()
    const cleanup = async () => {
        config.store.mcp.enabled = false
        await service.refresh()
        windowEvents.dispatchEvent(new Event('beforeunload'))
    }
    return { service, config, secrets, ipcRenderer, cleanup }
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
            groups: [{ id: 'group', name: 'Group' }],
            connections: [{ id: 'one', name: 'One', type: 'ssh', group: 'group' }],
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

test('created, edited and revoked tokens affect authenticated HTTP requests', async () => {
    const { service, config, secrets, cleanup } = setup()
    try {
        const permissions = newMCPPermissions()
        permissions.tools = ['list_connections']
        const token = await service.createToken('Agent', permissions)
        assert.equal(secrets.length, 1)
        config.store.mcp.enabled = true
        await service.refresh()
        const call = () => fetch(service.address!, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        assert.equal((await (await call()).json()).result.tools.length, 1)
        await service.updateToken(config.store.mcp.tokens[0].id, newMCPPermissions())
        assert.equal((await (await call()).json()).result.tools.length, 0)
        await service.removeToken(config.store.mcp.tokens[0].id)
        assert.equal((await call()).status, 401)
        assert.equal(secrets.length, 0)
    } finally { await cleanup() }
})
