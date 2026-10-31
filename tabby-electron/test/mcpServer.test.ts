import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { MCPHTTPServer } from '../src/mcp/server'
import { newMCPPermissions } from '../src/mcp/access'

const bearer = 'a'.repeat(64)
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

function setup () {
    const token = { ...newMCPPermissions(), id: 'test', name: 'Agent' }
    token.tools = ['list_connection_groups', 'list_connections', 'list_group_connections']
    token.connections.ids = ['one']
    const state = { valid: true }
    const server = new MCPHTTPServer({
        authenticate: async value => state.valid && value === bearer ? token : null,
        getCatalog: async () => ({
            groups: [{ id: 'group', name: 'Group' }, { id: 'hidden', name: 'Hidden' }],
            connections: [
                { id: 'one', name: 'One', type: 'ssh', group: 'group' },
                { id: 'two', name: 'Two', type: 'ssh', group: 'group' },
            ],
        }),
    })
    return { server, token, state }
}

async function rpc (server: MCPHTTPServer, method: string, params: object = {}, headers: Record<string, string> = {}) {
    const response = await fetch(server.address!, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return { status: response.status, body: await response.json() }
}

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

test('tool permissions are checked again after asynchronous catalog loading', async () => {
    const token = { ...newMCPPermissions(), id: 'test', name: 'Agent' }
    token.tools = ['list_connections']
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
        token.tools = []
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
        token.tools = ['list_connections']
        const updated = await rpc(server, 'tools/list')
        assert.deepEqual(updated.body.result.tools.map(tool => tool.name), ['list_connections'])
        const denied = await rpc(server, 'tools/call', { name: 'list_group_connections', arguments: { groupId: 'group' } })
        assert.equal(denied.body.result.isError, true)
    } finally {
        await server.stop()
    }
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
