import assert from 'node:assert/strict'
import { test } from 'node:test'
import '@angular/compiler'
import { MCPSettingsTabComponent } from '../src/components/mcpSettingsTab.component'
import { MCPTokenModalComponent } from '../src/components/mcpTokenModal.component'
import { newMCPPermissions } from '../src/mcp/access'

function setup () {
    const calls: any[] = []
    const mcp = {
        settings: { enabled: false, port: null as number|null, lastRandomPort: null as number|null, tokens: [] as any[] },
        refresh: async () => { calls.push('refresh') },
        getCatalog: async () => ({ groups: [], connections: [] }),
        createToken: async (name, permissions) => { calls.push({ name, permissions }); return 'plaintext-once' },
        updateToken: async (id, permissions, name) => { calls.push({ id, permissions, name }) },
        unlockVault: async () => { throw new Error('Vault unlock cancelled') },
    }
    const config = { fail: false, save: async () => { if (config.fail) { throw new Error('Write failed') }; calls.push('save') } }
    let editor: MCPTokenModalComponent
    const modals: any[] = []
    const ngbModal = {
        open: (_type, options) => {
            let resolveResult, rejectResult
            const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
            const modal = { close: value => resolveResult(value), dismiss: () => { if (options.beforeDismiss()) { rejectResult() } } }
            editor = new MCPTokenModalComponent(mcp as any, modal as any, ngbModal as any)
            const ref = { componentInstance: editor, result, close: modal.close }
            modals.push(ref)
            return ref
        },
    }
    const component = new MCPSettingsTabComponent(mcp as any, {} as any, config as any, { setClipboard: content => calls.push(content) } as any, ngbModal as any)
    return { component, mcp, config, calls, modals, get editor () { return editor } }
}

test('settings preview tracks explicit and remembered ports and validates input', async () => {
    const { component, mcp, calls } = setup()
    assert.match(component.previewAddress, /<automatic>/)
    mcp.settings.lastRandomPort = 12345
    assert.equal(component.previewAddress, 'http://127.0.0.1:12345/mcp')
    component.port = 23456
    await component.saveSettings(true)
    assert.equal(component.previewAddress, 'http://127.0.0.1:23456/mcp')
    assert.deepEqual(calls, ['save', 'refresh'])
    component.port = 65536
    await component.saveSettings(true)
    assert.match(component.error!, /port/)
    assert.equal(mcp.settings.port, 23456)
    await component.saveSettings(false)
    assert.equal(mcp.settings.enabled, false, 'an invalid draft port must not prevent stopping the server')
})

test('failed settings writes restore previous values and clear the busy state', async () => {
    const { component, mcp, config } = setup()
    config.fail = true
    component.port = 12345
    await component.saveSettings(true)
    assert.equal(mcp.settings.enabled, false)
    assert.equal(mcp.settings.port, null)
    assert.equal(component.error, 'Write failed')
    assert.equal(component.busy, false)
})

test('cancelled vault unlock exposes a translatable message and clears busy state', async () => {
    const { component } = setup()
    await component.unlockVault()
    assert.equal(component.error, 'Vault unlock cancelled')
    assert.equal(component.busy, false)
})

test('creation shows the token once and clearing/destroying the page forgets it', async () => {
    const state = setup()
    const { component, calls } = state
    await component.openEditor()
    const editor = state.editor
    editor.ngOnInit()
    editor.setConnectionOperations(true)
    editor.permissions.connections.one = { included: true, overrides: {} }
    await editor.save()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(component.editorOpen, false)
    assert.equal(component.createdToken, 'plaintext-once')
    assert.equal(calls[0].name, '', 'a name is optional')
    component.copy(component.createdToken!)
    assert.deepEqual(calls[1], { text: 'plaintext-once' })
    component.ngOnDestroy()
    assert.equal(component.createdToken, null)
})

test('editing clones permissions and supports removing independent selections', async () => {
    const state = setup()
    const { component, calls } = state
    const token = { ...newMCPPermissions(), id: 'id', name: 'Agent' }
    token.groups.group = { access: true }
    token.connections.one = { included: true, overrides: { upload: false } }
    await component.openEditor(token)
    const editor = state.editor
    editor.ngOnInit()
    assert.equal(editor.invalidPermissions, false)
    editor.permissions.groups.group.access = false
    editor.permissions.connections.one.overrides.upload = true
    editor.name = 'Renamed'
    assert.deepEqual(token.groups.group, { access: true })
    assert.equal(token.connections.one.overrides.upload, false)
    await editor.save()
    assert.equal(component.createdToken, null)
    assert.equal(calls[0].id, 'id')
    assert.deepEqual(calls[0].permissions.groups.group, { access: false })
    assert.equal(calls[0].name, 'Renamed')
})

test('token summaries reject unsupported policies without changing their persisted grants', () => {
    const { component, mcp } = setup()
    const legacy = { id: 'legacy', name: 'Old agent', tools: ['list_connections'], groups: { mode: 'all', ids: [] }, connections: { mode: 'all', ids: [] } }
    const malformed = { id: 'malformed', name: 'Invalid agent', capabilities: ['connection_operations'], groups: {}, connections: { one: null } }
    const valid = { ...newMCPPermissions(), id: 'valid', name: 'Current agent' }
    valid.capabilities = ['connection_operations']
    valid.connections = { one: { included: true, overrides: {} }, two: { included: false, overrides: { access: true } } }
    mcp.settings.tokens = [legacy, malformed, valid]
    const snapshot = JSON.stringify(mcp.settings.tokens)
    assert.deepEqual(component.tokenRows.map(row => [row.invalidPermissions, row.capabilityCount, row.includedConnectionCount]), [
        [true, 0, 0], [true, 0, 0], [false, 1, 1],
    ])
    assert.equal(JSON.stringify(mcp.settings.tokens), snapshot)
    assert.equal(component.tokenRows[0], component.tokenRows[0], 'unchanged metadata reuses the safe presentation row')
    mcp.settings.tokens[0] = { ...newMCPPermissions(), id: legacy.id, name: legacy.name }
    assert.equal(component.tokenRows[0].invalidPermissions, false, 'saved replacement metadata is validated again')
})

test('invalid token metadata is isolated from render bindings without modifying configuration', () => {
    const { component, mcp } = setup()
    const legacy = { id: 'legacy', name: 'Old agent', tools: ['list_connections'], groups: { mode: 'all', ids: [] }, connections: { mode: 'all', ids: [] } }
    const valid = { ...newMCPPermissions(), id: 'valid', name: '' }
    const records = [null, 2, {}, { name: '' }, { id: 'bad-name', name: 2 }, { id: 'bad-preview', name: '', preview: {} }, valid, legacy]
    mcp.settings.tokens = records
    const snapshot = JSON.stringify(records)
    assert.equal(component.invalidTokenRecords, true)
    assert.deepEqual(component.tokenRows.map(row => component.trackTokenRow(0, row)), ['valid', 'legacy'])
    assert.deepEqual(component.tokenRows.map(row => [component.tokenLabel(row.token), row.invalidPermissions]), [['valid…alid', false], ['Old agent', true]])
    assert.equal(JSON.stringify(mcp.settings.tokens), snapshot)
    assert.equal(mcp.settings.tokens, records)
    for (const invalid of [null, {}, 'tokens']) {
        mcp.settings.tokens = invalid as any
        assert.deepEqual(component.tokenRows, [])
        assert.equal(component.invalidTokenRecords, true)
        assert.equal(mcp.settings.tokens, invalid)
    }
    mcp.settings.tokens = [valid]
    assert.equal(component.invalidTokenRecords, false)
})

test('editing an unsupported policy starts denied and updates permissions only on explicit save', async () => {
    const state = setup()
    const legacy = { id: 'legacy', name: 'Old agent', tools: ['list_connections'], groups: { mode: 'all', ids: [] }, connections: { mode: 'all', ids: [] } }
    const snapshot = JSON.stringify(legacy)
    await state.component.openEditor(legacy as any)
    state.editor.ngOnInit()
    assert.equal(state.editor.invalidPermissions, true)
    assert.equal(state.editor.connectionOperationsEnabled, false)
    assert.deepEqual(state.editor.permissions, newMCPPermissions())
    state.editor.cancel()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(state.calls, [])
    assert.equal(JSON.stringify(legacy), snapshot)
    await state.component.openEditor(legacy as any)
    state.editor.ngOnInit()
    await state.editor.save()
    assert.deepEqual(state.calls, [{ id: 'legacy', permissions: newMCPPermissions(), name: 'Old agent' }])
    assert.equal(JSON.stringify(legacy), snapshot, 'the editor does not mutate the original policy object')
})

test('dirty dismissal requires confirmation and busy saves cannot be dismissed or duplicated', async () => {
    const state = setup()
    await state.component.openEditor()
    const editor = state.editor
    editor.ngOnInit()
    editor.name = 'Draft'
    editor.cancel()
    assert.equal(editor.discardPrompt, true)
    assert.equal(state.component.editorOpen, true)
    let finish
    state.mcp.createToken = () => new Promise(resolve => { finish = resolve }) as any
    const saving = editor.save()
    assert.equal(editor.canDismiss(), false)
    await editor.save()
    finish('created-once')
    await saving
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.component.createdToken, 'created-once')
})

test('failed saves preserve the draft and allow retrying', async () => {
    const state = setup()
    await state.component.openEditor()
    const editor = state.editor
    editor.ngOnInit()
    editor.name = 'Agent'
    state.mcp.createToken = async () => { throw new Error('Save failed') }
    await editor.save()
    assert.equal(editor.error, 'Save failed')
    assert.equal(editor.name, 'Agent')
    assert.equal(editor.busy, false)
    assert.equal(state.component.editorOpen, true)
    editor.discard()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.component.editorOpen, false)
    assert.equal(state.component.createdToken, null)
})

test('destroying settings while a save completes does not retain the plaintext token', async () => {
    const state = setup()
    await state.component.openEditor()
    state.editor.ngOnInit()
    let finish
    state.mcp.createToken = () => new Promise(resolve => { finish = resolve }) as any
    const saving = state.editor.save()
    state.component.ngOnDestroy()
    finish('must-not-retain')
    await saving
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.component.createdToken, null)
})

test('modal navigation scrolls only its content and disabling the package retains connection rules', async () => {
    const state = setup()
    await state.component.openEditor()
    const editor = state.editor
    editor.ngOnInit()
    let destination
    editor.formPage = { nativeElement: {
        scrollTop: 100,
        getBoundingClientRect: () => ({ top: 50 }),
        scrollTo: options => { destination = options.top },
    } } as any
    editor.navigate({ id: 'tools', getBoundingClientRect: () => ({ top: 250 }) } as any)
    assert.equal(destination, 300)
    assert.equal(editor.activeSection, 'tools')
    editor.permissions.connections.one = { included: true, overrides: { access: true } }
    editor.setConnectionOperations(true)
    editor.setConnectionOperations(false)
    assert.equal(editor.connectionOperationsEnabled, false)
    assert.deepEqual(editor.permissions.connections.one, { included: true, overrides: { access: true } })
})
