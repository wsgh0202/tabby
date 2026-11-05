import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { networkInterfaces } from 'node:os'
import { formatMCPAddress } from '../src/mcp/listenAddress'
import { MCPHTTPServer } from '../src/mcp/server'
import { newMCPPermissions } from '../src/mcp/access'
import { MCPToolError } from '../src/mcp/tools'

const bearer = 'a'.repeat(64)
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

function setup () {
    const token = { ...newMCPPermissions(), id: 'test', name: 'Agent' }
    token.capabilities = ['connection_operations']
    token.connections.one = { included: true, overrides: {} }
    const state = { valid: true, calls: [] as string[], closeTab: false, origin: null as { tokenName: string, source: string }|null, operation: async () => ({ ok: true }) as unknown }
    const server = new MCPHTTPServer({
        authenticate: async value => state.valid && value === bearer ? token : null,
        getCatalog: async () => ({
            groups: [{ id: 'group', name: 'Group' }, { id: 'hidden', name: 'Hidden' }],
            connections: [
                { id: 'one', name: 'One', type: 'ssh', group: 'group' },
                { id: 'two', name: 'Two', type: 'ssh', group: 'group' },
            ],
        }),
        callOperation: async (_tokenId, _connection, name, _args, authorize, origin, closeTab) => {
            state.closeTab = closeTab ?? false
            state.origin = origin
            state.calls.push(name)
            if (!await authorize()) { throw new Error('Denied') }
            return state.operation()
        },
    })
    return { server, token, state }
}

async function rpc (server: MCPHTTPServer, method: string, params: object = {}, headers: Record<string, string> = {}) {
    const response = await fetch(server.address!, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text()
    return { status: response.status, body }
}

test('close-tab policy defaults off, inherits and overrides without changing the agent protocol', async () => {
    const { server, token, state } = setup()
    token.groups.group = { access: true }
    state.operation = async () => ({ closed: true })
    try {
        await server.start(null, null)
        const tools = (await rpc(server, 'tools/list')).body.result.tools
        const close = () => rpc(server, 'tools/call', { name: 'close_connection', arguments: { connectionId: 'one', sessionId: 'session' } })
        const initial = (await close()).body.result
        assert.equal(state.closeTab, false)
        token.groups.group.close_tab = true
        assert.deepEqual((await close()).body.result, initial)
        assert.equal(state.closeTab, true)
        assert.deepEqual((await rpc(server, 'tools/list')).body.result.tools, tools)
        token.connections.one.overrides.close_tab = false
        assert.deepEqual((await close()).body.result, initial)
        assert.equal(state.closeTab, false)
        // This option must never grant access to the close tool itself.
        token.groups.group.access = false
        token.connections.one.overrides.close_tab = true
        assert.equal((await close()).body.result.isError, true)
    } finally { await server.stop() }
})

test('official SDK clients can initialize, list and call tools over Streamable HTTP', async () => {
    const { server } = setup()
    const client = new Client({ name: 'integration-test', version: '1' })
    try {
        await server.start(null, null)
        await client.connect(new StreamableHTTPClientTransport(new URL(server.address!), {
            requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        }))
        assert.equal((await client.listTools()).tools.length, 3)
        const result = await client.callTool({ name: 'list_connections', arguments: {} })
        assert.equal(result.isError, undefined)
        assert.deepEqual(JSON.parse(result.content[0].text).map(connection => connection.id), ['one'])
    } finally {
        await client.close()
        await server.stop()
    }
})

test('opening origin uses the authenticated token and TCP peer, not client-supplied headers', async () => {
    const { server, state, token } = setup()
    token.connections.one.overrides.access = true
    try {
        await server.start(null, null)
        const result = await rpc(server, 'tools/call', { name: 'open_connection', arguments: { connectionId: 'one' } }, {
            'X-Forwarded-For': '203.0.113.99', 'X-Real-IP': '203.0.113.98', 'User-Agent': 'Untrusted agent',
        })
        assert.equal(result.body.result.isError, undefined)
        assert.deepEqual(state.origin, { tokenName: 'Agent', source: '127.0.0.1' })
    } finally { await server.stop() }
})

test('tool permissions are checked again after asynchronous catalog loading', async () => {
    const token = { ...newMCPPermissions(), id: 'test', name: 'Agent' }
    token.capabilities = ['connection_operations']
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const server = new MCPHTTPServer({
        authenticate: async () => token,
        getCatalog: async () => { entered(); await gate; return { groups: [], connections: [] } },
    })
    try {
        await server.start(null, null)
        const response = rpc(server, 'tools/call', { name: 'list_connections' })
        await waiting
        token.capabilities = []
        release()
        assert.equal((await response).body.result.isError, true)
    } finally { release(); await server.stop() }
})

test('SDK initialization and dynamic tools/list honor the current token', async () => {
    const { server, token } = setup()
    try {
        await server.start(null, null)
        const initialized = await rpc(server, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
        assert.equal(initialized.status, 200)
        assert.equal(initialized.body.result.serverInfo.name, 'tabby')
        const listed = await rpc(server, 'tools/list')
        assert.equal(listed.body.result.tools.length, 3)
        token.capabilities = []
        const updated = await rpc(server, 'tools/list')
        assert.deepEqual(updated.body.result.tools, [])
        const denied = await rpc(server, 'tools/call', { name: 'list_group_connections', arguments: { groupId: 'group' } })
        assert.equal(denied.body.result.isError, true)
    } finally {
        await server.stop()
    }
})

test('each capability is advertised and authorized independently from connection discovery', async () => {
    const { server, token, state } = setup()
    try {
        await server.start(null, null)
        token.groups.group = { view_config: true, upload: true }
        let listed = (await rpc(server, 'tools/list')).body.result.tools.map(tool => tool.name)
        assert.ok(listed.includes('get_connection_config'))
        assert.ok(listed.includes('upload_file'))
        assert.ok(!listed.includes('download_file'))
        assert.ok(!listed.includes('open_connection'))
        const call = (name, connectionId = 'one', extra = {}) => rpc(server, 'tools/call', { name, arguments: { connectionId, ...extra } })
        assert.equal((await call('get_connection_config')).body.result.isError, undefined)
        assert.equal((await call('get_connection_config', 'two')).body.result.isError, true, 'guessing a sibling ID cannot expand scope')
        assert.equal((await call('open_connection')).body.result.isError, true)
        token.connections.one.overrides.view_config = false
        assert.equal((await call('get_connection_config')).body.result.isError, true)
        assert.deepEqual(state.calls, ['get_connection_config'])
        token.connections.one.included = false
        listed = (await rpc(server, 'tools/list')).body.result.tools.map(tool => tool.name)
        assert.deepEqual(listed, ['list_connection_groups', 'list_connections', 'list_group_connections'])
        assert.equal((await call('upload_file', 'one', { path: '/file', data: '' })).body.result.isError, true)
    } finally { await server.stop() }
})

test('malformed operation arguments never reach the adapter and errors cannot leak credentials', async () => {
    const { server, token, state } = setup()
    token.groups.group = { access: true, edit_config: true }
    try {
        await server.start(null, null)
        for (const args of [
            { connectionId: 'one', columns: 0 },
            { connectionId: 'one', rows: 3.5 },
            { connectionId: 'one', command: 'unexpected' },
            { connectionId: ['one'] },
        ]) {
            assert.equal((await rpc(server, 'tools/call', { name: 'open_connection', arguments: args })).body.result.isError, true)
        }
        assert.equal((await rpc(server, 'tools/call', { name: 'update_connection_config', arguments: { connectionId: 'one', changes: { group: 'hidden' } } })).body.result.isError, true)
        assert.equal(state.calls.length, 0)
        state.operation = async () => { throw new Error('password=secret') }
        let result = (await rpc(server, 'tools/call', { name: 'open_connection', arguments: { connectionId: 'one' } })).body.result
        assert.equal(result.isError, true)
        assert.doesNotMatch(JSON.stringify(result), /secret/)
        state.operation = async () => { throw new MCPToolError('This connection type does not support file transfer') }
        result = (await rpc(server, 'tools/call', { name: 'open_connection', arguments: { connectionId: 'one' } })).body.result
        assert.match(result.content[0].text, /does not support/)
    } finally { await server.stop() }
})

test('revoking an operation during an asynchronous read suppresses its result', async () => {
    const { server, token, state } = setup()
    token.groups.group = { view_config: true }
    state.operation = async () => {
        token.connections.one.included = false
        return { options: { host: 'sensitive-host' } }
    }
    try {
        await server.start(null, null)
        const result = (await rpc(server, 'tools/call', { name: 'get_connection_config', arguments: { connectionId: 'one' } })).body.result
        assert.equal(result.isError, true)
        assert.doesNotMatch(JSON.stringify(result), /sensitive-host/)
    } finally { await server.stop() }
})

test('the HTTP envelope accepts a complete 4 MiB base64 upload and rejects oversized bodies', async () => {
    const { server, token, state } = setup()
    token.groups.group = { upload: true }
    try {
        await server.start(null, null)
        const data = Buffer.alloc(4 * 1024 * 1024, 255).toString('base64')
        const result = await rpc(server, 'tools/call', { name: 'upload_file', arguments: { connectionId: 'one', path: '/file', data } })
        assert.equal(result.status, 200)
        assert.equal(result.body.result.isError, undefined)
        assert.deepEqual(state.calls, ['upload_file'])
        const response = await fetch(server.address!, {
            method: 'POST',
            headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: ' '.repeat(6 * 1024 * 1024 + 1),
        })
        assert.equal(response.status, 413)
        assert.deepEqual(state.calls, ['upload_file'], 'oversized requests never reach connection operations')
    } finally { await server.stop() }
})

test('tool results filter connections even when the client supplies group parameters', async () => {
    const { server } = setup()
    try {
        await server.start(null, null)
        const result = await rpc(server, 'tools/call', { name: 'list_group_connections', arguments: { groupId: 'group' } })
        assert.deepEqual(JSON.parse(result.body.result.content[0].text).map(connection => connection.id), ['one'])
        const denied = await rpc(server, 'tools/call', { name: 'list_group_connections', arguments: { groupId: 'hidden' } })
        assert.equal(denied.body.result.isError, true)
    } finally {
        await server.stop()
    }
})

test('HTTP rejects missing/revoked tokens, foreign origins and DNS rebinding hosts', async () => {
    const { server, state } = setup()
    try {
        await server.start(null, null)
        assert.equal((await fetch(server.address!)).status, 401)
        assert.equal((await fetch(server.address!, { headers: { Authorization: `Bearer ${bearer}` } })).status, 405)
        assert.equal((await fetch(server.address!, { headers: { Origin: 'https://example.com' } })).status, 403)
        const hostStatus = await new Promise<number>(resolve => {
            const req = request(server.address!, { headers: { Host: 'example.com' } }, response => {
                response.resume()
                resolve(response.statusCode!)
            })
            req.end()
        })
        assert.equal(hostStatus, 403)
        state.valid = false
        assert.equal((await fetch(server.address!, { headers: { Authorization: `Bearer ${bearer}` } })).status, 401)
    } finally {
        await server.stop()
    }
    assert.equal(server.address, null)
})

test('random ports reuse the previous port and fall back only when it is occupied', async () => {
    const { server } = setup()
    const blocker = createServer()
    try {
        const first = await server.start(null, null)
        await server.stop()
        assert.equal(await server.start(null, first), first)
        await server.stop()
        await new Promise<void>(resolve => blocker.listen(first, '127.0.0.1', resolve))
        assert.notEqual(await server.start(null, first), first)
        await assert.rejects(server.start(first, null), { code: 'EADDRINUSE' })
        assert.equal(server.address, null)
        for (const port of [0, -1, 65536, 1.5, NaN]) {
            await assert.rejects(server.start(port, null), /port/)
        }
    } finally {
        await server.stop()
        await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
})

test('wildcard IPv4 listening accepts the destination IP while retaining authentication and host/origin checks', async () => {
    const { server } = setup()
    try {
        await server.start(null, null, '0.0.0.0')
        assert.equal(server.address, `http://127.0.0.1:${server.port}/mcp`)
        assert.equal((await rpc(server, 'tools/list')).status, 200)
        assert.equal((await fetch(server.address!)).status, 401)
        assert.equal((await rpc(server, 'tools/list', {}, { Origin: `http://127.0.0.1:${server.port}` })).status, 200)
        assert.equal((await rpc(server, 'tools/list', {}, { Origin: 'http://untrusted.invalid' })).status, 403)
        const status = await new Promise<number>((resolve, reject) => {
            const req = request(server.address!, { headers: { Host: `untrusted.invalid:${server.port}`, Authorization: `Bearer ${bearer}` } }, response => {
                response.resume(); resolve(response.statusCode!)
            })
            req.on('error', reject)
            req.end()
        })
        assert.equal(status, 403)
    } finally { await server.stop() }
})

test('literal IPv6 and dual-stack wildcard listeners serve authenticated MCP requests', async context => {
    for (const host of ['::1', '::']) {
        const { server } = setup()
        try {
            try {
                await server.start(null, null, host)
            } catch (error) {
                if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
                    context.skip('IPv6 networking is not available')
                    return
                }
                throw error
            }
            assert.equal(server.address, `http://[::1]:${server.port}/mcp`)
            assert.equal((await rpc(server, 'tools/list')).status, 200)
            assert.equal((await rpc(server, 'tools/list', {}, { Origin: `http://[::1]:${server.port}` })).status, 200)
            assert.equal((await rpc(server, 'tools/list', {}, { Origin: 'http://untrusted.invalid' })).status, 403)
            if (host === '::') {
                const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { headers: { Authorization: `Bearer ${bearer}` } })
                assert.equal(response.status, 405, 'IPv4-mapped sockets keep accepting their IPv4 Host header')
            }
        } finally { await server.stop() }
    }
})

test('a real LAN interface accepts official SDK clients and rejects foreign Host/Origin headers', async context => {
    const host = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address
    if (!host) { context.skip('No IPv4 LAN interface is available'); return }
    const { server } = setup()
    const client = new Client({ name: 'lan-test', version: '1' })
    try {
        await server.start(null, null, host)
        assert.equal(server.address, formatMCPAddress(host, server.port!))
        await client.connect(new StreamableHTTPClientTransport(new URL(server.address!), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }))
        assert.equal((await client.listTools()).tools.length, 3)
        assert.equal((await fetch(server.address!)).status, 401)
        assert.equal((await rpc(server, 'tools/list', {}, { Origin: `http://${host}:${server.port}` })).status, 200)
        assert.equal((await rpc(server, 'tools/list', {}, { Origin: `http://127.0.0.1:${server.port}` })).status, 403, 'a LAN request cannot claim a different local origin')
        const badHost = await new Promise<number>((resolve, reject) => {
            const req = request(server.address!, { headers: { Host: `untrusted.invalid:${server.port}`, Authorization: `Bearer ${bearer}` } }, response => {
                response.resume(); resolve(response.statusCode!)
            })
            req.on('error', reject)
            req.end()
        })
        assert.equal(badHost, 403)
        await client.close()
        await server.start(null, null, '0.0.0.0')
        const response = await fetch(formatMCPAddress(host, server.port!), { headers: { Authorization: `Bearer ${bearer}` } })
        assert.equal(response.status, 405, 'wildcard listens on the LAN address as well as loopback')
    } finally { await client.close(); await server.stop() }
})

test('invalid listener IP values never fall back to a wildcard address', async () => {
    const { server } = setup()
    try {
        for (const host of ['', 'localhost', 'bad.invalid', '192.168.1.999', '[::1]', 'fe80::1%eth0']) {
            await assert.rejects(server.start(null, null, host), /valid IPv4 or IPv6/)
            assert.equal(server.address, null)
        }
    } finally { await server.stop() }
})
