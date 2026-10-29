import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { VaultSecret } from 'tabby-core'
import { MCPTokens, MCPToken, hashMCPToken, MCP_TOKEN_ID_PREFIX } from '../src/mcp/tokens'
import { newMCPPermissions } from '../src/mcp/access'

function setup () {
    const secrets: VaultSecret[] = []
    const entries: MCPToken[] = []
    const state = { enabled: true, open: true, loads: 0 }
    const tokens = new MCPTokens({
        isEnabled: () => state.enabled,
        isOpen: () => state.open,
        load: async () => { state.loads++; return { config: {}, secrets } },
        addSecret: async secret => { secrets.push(secret) },
        removeSecret: async (type, key) => {
            const index = secrets.findIndex(secret => secret.type === type && secret.key['id'] === key.id)
            if (index !== -1) { secrets.splice(index, 1) }
        },
    }, () => entries)
    return { tokens, secrets, entries, state }
}

test('multiple named tokens store only hashes in custom:password secrets', async () => {
    const { tokens, secrets, entries } = setup()
    const first = await tokens.create(' Agent A ', newMCPPermissions())
    const second = await tokens.create('Agent B', newMCPPermissions())
    entries.push(first.entry, second.entry)
    assert.notEqual(first.token, second.token)
    assert.equal(first.token.length, 64)
    assert.equal(secrets[0].type, 'custom:password')
    assert.deepEqual(secrets[0].key, { id: MCP_TOKEN_ID_PREFIX + hashMCPToken(first.token), description: 'MCP token: Agent A' })
    assert.equal(secrets[0].value, hashMCPToken(first.token))
    assert.ok(!JSON.stringify({ entries, secrets }).includes(first.token))
    assert.equal(await tokens.authenticate(first.token), first.entry)
    assert.equal(await tokens.authenticate(second.token), second.entry)
    assert.equal(await tokens.authenticate('wrong'), null)
    assert.equal(await tokens.authenticate(secrets[0].value), null)
})

test('authentication observes edits, revocations and vault deletion immediately', async () => {
    const { tokens, entries, secrets } = setup()
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    entries[0].tools = ['list_connections']
    assert.deepEqual((await tokens.authenticate(created.token))?.tools, ['list_connections'])
    const [entry] = entries.splice(0, 1)
    assert.equal(await tokens.authenticate(created.token), null)
    entries.push(entry)
    await tokens.remove(entry.id)
    assert.equal(secrets.length, 0)
    assert.equal(await tokens.authenticate(created.token), null)
})

test('locked or disabled vaults reject requests without prompting', async () => {
    const { tokens, state, entries } = setup()
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    state.open = false
    assert.equal(await tokens.authenticate(created.token), null)
    state.open = true
    state.enabled = false
    assert.equal(await tokens.authenticate(created.token), null)
    assert.equal(state.loads, 0)
    await assert.rejects(tokens.create('Another', newMCPPermissions()), /vault/)
    await assert.rejects(tokens.create('  ', newMCPPermissions()), /name/)
})

test('invalid stored hashes fail closed', async () => {
    const { tokens, entries, secrets } = setup()
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    secrets[0].value = 'invalid'
    assert.equal(await tokens.authenticate(created.token), null)
})
