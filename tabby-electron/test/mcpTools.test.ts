import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MCP_TOOLS, validateMCPToolArguments } from '../src/mcp/tools'

test('terminal and file schemas enforce bounded requests before side effects', () => {
    const validate = (name, args) => validateMCPToolArguments(MCP_TOOLS.find(tool => tool.name === name)!, args)
    validate('upload_file', { connectionId: 'ssh', path: '/data', data: '' })
    validate('read_connection', { connectionId: 'ssh', sessionId: 'session', cursor: 0, maxBytes: 1 })
    for (const args of [
        { connectionId: 'ssh', path: '/data', data: 'a'.repeat(5592409) },
        { connectionId: 'ssh', path: '/'.repeat(4097), data: '' },
        { connectionId: 'ssh', path: '/data' },
    ]) { assert.throws(() => validate('upload_file', args)) }
    assert.throws(() => validate('read_connection', { connectionId: 'ssh', sessionId: 'session', cursor: -1 }))
    assert.throws(() => validate('read_connection', { connectionId: 'ssh', sessionId: 'session', maxBytes: 65537 }))
    assert.throws(() => validate('write_connection', { connectionId: 'ssh', sessionId: 'session', input: 'a'.repeat(65537) }))
    assert.throws(() => validate('update_connection_config', { connectionId: 'ssh', changes: { type: 'local' } }))
    assert.throws(() => validate('list_connections', JSON.parse('{"__proto__":{}}')))
})

test('protocol descriptions omit configuration-only security notices', () => {
    for (const tool of MCP_TOOLS) {
        assert.doesNotMatch(tool.description, /warning|bypass|convenience|cannot prevent|security boundary/i)
        assert.equal(tool.inputSchema.additionalProperties, false)
    }
    assert.equal(new Set(MCP_TOOLS.map(tool => tool.name)).size, MCP_TOOLS.length)
})
