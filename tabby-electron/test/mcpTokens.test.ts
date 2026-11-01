import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Vault, VaultSecret } from 'tabby-core'
import { MCPTokens, MCPToken, MCPTokenVault, hashMCPToken, MCP_TOKEN_ID_PREFIX } from '../src/mcp/tokens'
import { newMCPPermissions } from '../src/mcp/access'
import { getMCPTokenLabel, isMCPTokenMetadata, previewMCPToken } from '../src/mcp/tokenDisplay'

function setup (withRevision = false) {
    const secrets: VaultSecret[] = []
    const entries: MCPToken[] = []
    const state = { enabled: true, open: true, loads: 0, revision: {} as object|null }
    const vault: MCPTokenVault = {
        isEnabled: () => state.enabled,
        isOpen: () => state.open,
        ...withRevision ? { getRevision: () => state.revision } : {},
        load: async () => { state.loads++; return { config: {}, secrets } },
        addSecret: async secret => { secrets.push(secret); state.revision = {} },
        removeSecret: async (type, key) => {
            const index = secrets.findIndex(secret => secret.type === type && secret.key['id'] === key.id)
            if (index !== -1) { secrets.splice(index, 1) }
            state.revision = {}
        },
    }
    const tokens = new MCPTokens(vault, () => entries)
    return { tokens, vault, secrets, entries, state }
}

function deferredVault () {
    let resolve: (value: Vault|null) => void
    let reject: (error: Error) => void
    const promise = new Promise<Vault|null>((accept, fail) => { resolve = accept; reject = fail })
    return { promise, resolve: value => resolve(value), reject: error => reject(error) }
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
    entries[0].capabilities = ['connection_operations']
    entries[0].connections.one = { included: true, overrides: { access: true } }
    assert.deepEqual((await tokens.authenticate(created.token))?.capabilities, ['connection_operations'])
    assert.deepEqual((await tokens.authenticate(created.token))?.connections.one, { included: true, overrides: { access: true } })
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
})

test('invalid stored hashes fail closed', async () => {
    const { tokens, entries, secrets } = setup()
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    secrets[0].value = 'invalid'
    assert.equal(await tokens.authenticate(created.token), null)
})

test('locking or disabling the vault during decryption invalidates an in-flight authentication', async () => {
    for (const field of ['enabled', 'open'] as const) {
        const { tokens, state, entries } = setup()
        const created = await tokens.create('Agent', newMCPPermissions())
        entries.push(created.entry)
        // authenticate() has entered load() but has not resumed after its await.
        const authentication = tokens.authenticate(created.token)
        state[field] = false
        assert.equal(await authentication, null)
    }
})

test('unnamed tokens use a non-authenticating preview without storing the bearer token', async () => {
    const { tokens, entries, secrets } = setup()
    const created = await tokens.create('  ', newMCPPermissions())
    entries.push(created.entry)
    assert.equal(created.entry.name, '')
    assert.equal(created.entry.preview, `${created.token.slice(0, 8)}…${created.token.slice(-4)}`)
    assert.equal(getMCPTokenLabel(created.entry), created.entry.preview)
    assert.equal(secrets[0].key['description'], `MCP token: ${created.entry.preview}`)
    assert.ok(!JSON.stringify({ entries, secrets }).includes(created.token))
    assert.equal(await tokens.authenticate(created.entry.preview!), null)
    assert.equal(await tokens.authenticate(created.token), created.entry)
})

test('display labels support named entries and unnamed previews', () => {
    const entry = { ...newMCPPermissions(), id: 'mcp:token:1234567890abcdef', name: 'Existing agent' }
    assert.equal(getMCPTokenLabel(entry), 'Existing agent')
    assert.equal(getMCPTokenLabel({ ...entry, name: '' }), '12345678…cdef')
    assert.equal(previewMCPToken('1234567890abcdef'), '12345678…cdef')
})

test('token metadata validation does not infer or require a supported policy', () => {
    const valid = { id: 'id', name: '' }
    assert.equal(isMCPTokenMetadata(valid), true)
    assert.equal(isMCPTokenMetadata({ ...valid, preview: 'preview' }), true)
    assert.equal(isMCPTokenMetadata({ ...valid, tools: ['list_connections'] }), true)
    assert.equal(isMCPTokenMetadata(Object.assign(Object.create(null), valid)), true)
    for (const invalid of [null, 1, 'token', [], {}, { name: '' }, { id: '', name: '' }, { id: 'id', name: 1 }, { ...valid, preview: 1 }, new Date()]) {
        assert.equal(isMCPTokenMetadata(invalid), false)
    }
})

test('authentication skips invalid metadata records and denies non-array collections', async () => {
    const { tokens, vault } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    let records: unknown = [null, {}, { ...created.entry, name: 1 }, { ...created.entry, preview: {} }, created.entry]
    const reader = new MCPTokens(vault, () => records as MCPToken[])
    assert.equal(await reader.authenticate(created.token), created.entry)
    for (const invalid of [null, {}, 'tokens']) {
        records = invalid
        assert.equal(await reader.authenticate(created.token), null)
    }
})

test('creation snapshots nested group templates and connection overrides', async () => {
    const { tokens } = setup()
    const permissions = newMCPPermissions()
    permissions.capabilities = ['connection_operations']
    permissions.groups.parent = { access: true, upload: false }
    permissions.connections.one = { included: true, overrides: { download: true } }
    const { entry } = await tokens.create('Agent', permissions)
    permissions.capabilities = []
    permissions.groups.parent.access = false
    permissions.connections.one.included = false
    permissions.connections.one.overrides.download = false
    assert.deepEqual(entry.capabilities, ['connection_operations'])
    assert.deepEqual(entry.groups.parent, { access: true, upload: false })
    assert.deepEqual(entry.connections.one, { included: true, overrides: { download: true } })
})

test('a stable vault revision decrypts once across repeated and parallel authentications', async () => {
    const { tokens, entries, state } = setup(true)
    const first = await tokens.create('First', newMCPPermissions())
    const second = await tokens.create('Second', newMCPPermissions())
    entries.push(first.entry, second.entry)
    const results = await Promise.all(Array.from({ length: 20 }, () => tokens.authenticate(first.token)))
    assert.ok(results.every(entry => entry === first.entry))
    assert.equal(await tokens.authenticate(second.token), second.entry)
    assert.equal(await tokens.authenticate('unknown-token'), null)
    assert.equal(state.loads, 1)
})

test('cached credentials never cache policy edits or metadata revocation', async () => {
    const { tokens, entries, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    entries[0] = { ...created.entry, capabilities: ['connection_operations'], connections: { one: { included: true, overrides: { access: true } } } }
    assert.equal(await tokens.authenticate(created.token), entries[0])
    entries[0].connections.one.included = false
    assert.equal((await tokens.authenticate(created.token))?.connections.one.included, false)
    entries.splice(0)
    assert.equal(await tokens.authenticate(created.token), null)
    assert.equal(state.loads, 1, 'policy-only edits must not derive the vault key again')
})

test('a valid credential cannot authorize malformed or unsupported permission metadata', async () => {
    const { tokens, entries, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    entries[0] = { id: created.entry.id, name: 'Agent', tools: ['list_connections'], groups: { mode: 'all', ids: [] }, connections: { mode: 'all', ids: [] } } as any
    assert.equal(await tokens.authenticate(created.token), null)
    entries[0] = { ...created.entry, capabilities: 'connection_operations' } as any
    assert.equal(await tokens.authenticate(created.token), null)
    entries[0] = created.entry
    assert.equal(await tokens.authenticate(created.token), created.entry)
    assert.equal(state.loads, 1, 'recovering permission metadata does not require caching authorization decisions')
})

test('unversioned adapters continue to load credentials for every authentication', async () => {
    const { tokens, entries, state } = setup()
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    assert.equal(state.loads, 2)
})

test('observing a locked or disabled vault clears cached hashes before unlocking', async () => {
    for (const field of ['enabled', 'open'] as const) {
        const { tokens, entries, state } = setup(true)
        const created = await tokens.create('Agent', newMCPPermissions())
        entries.push(created.entry)
        assert.equal(await tokens.authenticate(created.token), created.entry)
        state[field] = false
        assert.equal(await tokens.authenticate(created.token), null)
        assert.equal(state.loads, 1)
        state[field] = true
        assert.equal(await tokens.authenticate(created.token), created.entry)
        assert.equal(state.loads, 2, 'unlocking must reload hashes even when the encrypted revision is unchanged')
    }
})

test('locking during a versioned load denies it and a later unlock can load the same revision', async () => {
    const { tokens, vault, entries, secrets, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    const pending = deferredVault()
    vault.load = async () => { state.loads++; return pending.promise }
    const authentication = tokens.authenticate(created.token)
    state.open = false
    pending.resolve({ config: {}, secrets })
    assert.equal(await authentication, null)
    state.open = true
    vault.load = async () => { state.loads++; return { config: {}, secrets } }
    assert.equal(await tokens.authenticate(created.token), created.entry)
    assert.equal(state.loads, 2)
})

test('an observed lock invalidates an older load even if it finishes after unlocking', async () => {
    const { tokens, vault, entries, secrets, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    const pending = deferredVault()
    vault.load = async () => { state.loads++; return state.loads === 1 ? pending.promise : { config: {}, secrets } }
    const obsolete = tokens.authenticate(created.token)
    state.open = false
    assert.equal(await tokens.authenticate(created.token), null)
    state.open = true
    assert.equal(await tokens.authenticate(created.token), created.entry)
    pending.resolve({ config: {}, secrets })
    assert.equal(await obsolete, null)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    assert.equal(state.loads, 2)
})

test('a changed encrypted revision denies an older load and retries against current credentials', async () => {
    const { tokens, vault, entries, secrets, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    const snapshot = { config: {}, secrets: [...secrets] }
    const pending = deferredVault()
    vault.load = async () => { state.loads++; return state.loads === 1 ? pending.promise : { config: {}, secrets } }
    const authentication = tokens.authenticate(created.token)
    secrets.splice(0)
    state.revision = {}
    pending.resolve(snapshot)
    assert.equal(await authentication, null)
    assert.equal(await tokens.authenticate(created.token), null)
    assert.equal(state.loads, 2)
})

test('an obsolete failing load does not clear a newer revision single-flight load', async () => {
    const { tokens, vault, entries, secrets, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    const first = deferredVault()
    const second = deferredVault()
    vault.load = async () => { state.loads++; return state.loads === 1 ? first.promise : second.promise }
    const obsolete = tokens.authenticate(created.token)
    state.revision = {}
    const current = tokens.authenticate(created.token)
    first.reject(new Error('Old decryption failed'))
    await assert.rejects(obsolete, /Old decryption failed/)
    const concurrent = tokens.authenticate(created.token)
    assert.equal(state.loads, 2)
    second.resolve({ config: {}, secrets })
    assert.equal(await current, created.entry)
    assert.equal(await concurrent, created.entry)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    assert.equal(state.loads, 2)
})

test('direct vault deletion invalidates cached credentials when its revision changes', async () => {
    const { tokens, entries, secrets, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    secrets.splice(0)
    state.revision = {}
    assert.equal(await tokens.authenticate(created.token), null)
    assert.equal(state.loads, 2)
})

test('failed revision reloads discard the previous hashes and allow a clean retry', async () => {
    const { tokens, vault, entries, state } = setup(true)
    const created = await tokens.create('Agent', newMCPPermissions())
    entries.push(created.entry)
    assert.equal(await tokens.authenticate(created.token), created.entry)
    state.revision = {}
    vault.load = async () => { state.loads++; throw new Error('Decryption failed') }
    await assert.rejects(tokens.authenticate(created.token), /Decryption failed/)
    vault.load = async () => { state.loads++; return { config: {}, secrets: [] } }
    assert.equal(await tokens.authenticate(created.token), null)
    assert.equal(state.loads, 3)
})
