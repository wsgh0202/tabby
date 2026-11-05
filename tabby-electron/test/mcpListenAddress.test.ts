import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MCP_HOST, formatMCPAddress, getMCPAllowedHosts, normalizeMCPHost } from '../src/mcp/listenAddress'

test('listener IP validation accepts literal IPv4/IPv6 and rejects URLs, names and scoped addresses', () => {
    assert.equal(DEFAULT_MCP_HOST, '127.0.0.1')
    assert.equal(normalizeMCPHost(' 192.168.1.20 '), '192.168.1.20')
    assert.equal(normalizeMCPHost('0.0.0.0'), '0.0.0.0')
    assert.equal(normalizeMCPHost('2001:DB8:0:0::1'), '2001:db8::1')
    for (const host of [undefined, null, 127, '', 'localhost', 'example.com', '127.0.0.999', '127.1', '[::1]', 'http://127.0.0.1', 'fe80::1%eth0', '::1/path']) {
        assert.throws(() => normalizeMCPHost(host), /valid IPv4 or IPv6/)
    }
})

test('copyable addresses format IPv6 and replace wildcard listeners with local destinations', () => {
    assert.equal(formatMCPAddress('192.168.1.20', 8000), 'http://192.168.1.20:8000/mcp')
    assert.equal(formatMCPAddress('::1', 8000), 'http://[::1]:8000/mcp')
    assert.equal(formatMCPAddress('0.0.0.0', '<automatic>'), 'http://127.0.0.1:<automatic>/mcp')
    assert.equal(formatMCPAddress('::', 8000), 'http://[::1]:8000/mcp')
})

test('request hosts derive from the accepted destination, including IPv4-mapped dual-stack sockets', () => {
    assert.deepEqual(getMCPAllowedHosts('192.168.1.20', 8000), ['192.168.1.20:8000'])
    assert.deepEqual(getMCPAllowedHosts('127.0.0.2', 8000), ['127.0.0.2:8000', 'localhost:8000'])
    assert.deepEqual(getMCPAllowedHosts('::ffff:192.168.1.20', 8000), ['[::ffff:c0a8:114]:8000', '192.168.1.20:8000'])
    assert.deepEqual(getMCPAllowedHosts('::ffff:127.0.0.1', 8000), ['[::ffff:7f00:1]:8000', '127.0.0.1:8000', 'localhost:8000'])
    assert.deepEqual(getMCPAllowedHosts('::1', 8000), ['[::1]:8000', 'localhost:8000'])
    assert.deepEqual(getMCPAllowedHosts(undefined, 8000), [])
})

test('default HTTP port accepts the authority serialized by standard URL clients', () => {
    for (const host of ['127.0.0.1', '192.168.1.20', '::1']) {
        const url = new URL(formatMCPAddress(host, 80))
        assert.ok(getMCPAllowedHosts(host, 80).includes(url.host))
        assert.ok(getMCPAllowedHosts(host, 80).includes(url.origin.slice('http://'.length)))
        assert.ok(!getMCPAllowedHosts(host, 8000).includes(url.host), 'other ports still require their explicit authority')
    }
})
