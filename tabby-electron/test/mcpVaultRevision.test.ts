import assert from 'node:assert/strict'
import { test } from 'node:test'
import '@angular/compiler'
import { VaultService } from '../../tabby-core/src/services/vault.service'
import { newMCPPermissions } from '../src/mcp/access'
import { MCPTokens, hashMCPToken, MCP_TOKEN_ID_PREFIX, MCP_TOKEN_TYPE } from '../src/mcp/tokens'

test('real vault revisions prevent cached credentials crossing an unobserved lock and failed unlock', async context => {
    const expirations: (() => void)[] = []
    context.mock.method(globalThis, 'setTimeout', callback => { expirations.push(callback); return 0 as any })
    let password = 'correct password'
    let prompts = 0
    const vault: VaultService = new (VaultService as any)(
        { run: callback => callback() },
        {},
        { open: () => { prompts++; return { result: Promise.resolve({ passphrase: password, rememberFor: 1 }) } } },
    )
    vault.forgetPassphrase()
    const bearer = 'b'.repeat(64)
    const hash = hashMCPToken(bearer)
    const entry = { ...newMCPPermissions(), id: MCP_TOKEN_ID_PREFIX + hash, name: 'Agent' }
    const contents = { config: {}, secrets: [{ type: MCP_TOKEN_TYPE, key: { id: entry.id }, value: hash }] }
    const encrypted = await vault.encrypt(contents, password)
    assert.ok(encrypted)
    vault.setStore(encrypted)
    let loads = 0
    const tokens = new MCPTokens({
        isEnabled: () => vault.isEnabled(), isOpen: () => vault.isOpen(),
        getRevision: () => vault.getCacheRevision(),
        load: async () => { loads++; return vault.load() },
        addSecret: async () => undefined, removeSecret: async () => undefined,
    }, () => [entry])
    try {
        assert.equal(await tokens.authenticate(bearer), null)
        assert.equal(prompts, 0, 'network authentication cannot open an unlock dialog')
        await vault.load() // Locally unlocking the real encrypted vault.
        const firstRevision = vault.getCacheRevision()
        assert.ok(firstRevision)
        assert.deepEqual(Object.keys(firstRevision), [], 'the revision contains no credential data')
        assert.equal(await tokens.authenticate(bearer), entry)
        assert.equal(await tokens.authenticate(bearer), entry)
        assert.equal(loads, 1)

        vault.forgetPassphrase()
        assert.equal(vault.getCacheRevision(), null)
        // No MCP call observed the locked interval. An unsuccessful new password
        // attempt must still invalidate the previous successful credential cache.
        password = 'incorrect password'
        await vault.getPassphrase()
        assert.notEqual(vault.getCacheRevision(), firstRevision)
        await assert.rejects(tokens.authenticate(bearer))
        assert.equal(loads, 2)
        assert.equal(vault.isOpen(), false)

        password = 'correct password'
        await vault.load()
        assert.equal(await tokens.authenticate(bearer), entry)
        const unlockedRevision = vault.getCacheRevision()
        expirations[expirations.length - 1]()
        assert.equal(vault.getCacheRevision(), null)
        await vault.getPassphrase()
        assert.notEqual(vault.getCacheRevision(), unlockedRevision, 'expiry and same-password re-entry change the revision')
        assert.equal(await tokens.authenticate(bearer), entry)
        assert.equal(loads, 4)

        const beforeStoreChange = vault.getCacheRevision()
        vault.setStore({ ...encrypted })
        assert.notEqual(vault.getCacheRevision(), beforeStoreChange)
        assert.equal(await tokens.authenticate(bearer), entry)
        assert.equal(loads, 5)
        const beforeEncryption = vault.getCacheRevision()
        await vault.encrypt(contents, password)
        assert.notEqual(vault.getCacheRevision(), beforeEncryption, 'changing a remembered encryption passphrase invalidates caches')
    } finally { vault.forgetPassphrase() }
})
