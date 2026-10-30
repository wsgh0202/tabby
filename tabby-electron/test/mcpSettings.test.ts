import assert from 'node:assert/strict'
import { test } from 'node:test'
import '@angular/compiler'
import { MCPSettingsTabComponent } from '../src/components/mcpSettingsTab.component'
import { MCPTokenModalComponent } from '../src/components/mcpTokenModal.component'
import { newMCPPermissions } from '../src/mcp/access'

function setup () {
    const calls: any[] = []
    const mcp = {
        settings: { enabled: false, port: null as number|null, lastRandomPort: null as number|null },
        refresh: async () => { calls.push('refresh') },
        getCatalog: async () => ({ groups: [], connections: [] }),
        createToken: async (name, permissions) => { calls.push({ name, permissions }); return 'plaintext-once' },
        updateToken: async (id, permissions, name) => { calls.push({ id, permissions, name }) },
    }
    const config = { fail: false, save: async () => { if (config.fail) { throw new Error('Write failed') }; calls.push('save') } }
    let editor: MCPTokenModalComponent
    const modals: any[] = []
    const ngbModal = {
        open: (_type, options) => {
            let resolveResult, rejectResult
            const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
            const modal = { close: value => resolveResult(value), dismiss: () => { if (options.beforeDismiss()) { rejectResult() } } }
            editor = new MCPTokenModalComponent(mcp as any, modal as any)
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

test('creation shows the token once and clearing/destroying the page forgets it', async () => {
    const state = setup()
    const { component, calls } = state
    await component.openEditor()
    const editor = state.editor
    editor.ngOnInit()
    editor.toggleSelection(editor.permissions.tools, 'list_connections', true)
    editor.toggleSelection(editor.permissions.connections.ids, 'one', true)
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
    token.groups.ids = ['group']
    await component.openEditor(token)
    const editor = state.editor
    editor.ngOnInit()
    editor.toggleSelection(editor.permissions.groups.ids, 'group', false)
    editor.name = 'Renamed'
    assert.deepEqual(token.groups.ids, ['group'])
    await editor.save()
    assert.equal(component.createdToken, null)
    assert.equal(calls[0].id, 'id')
    assert.deepEqual(calls[0].permissions.groups.ids, [])
    assert.equal(calls[0].name, 'Renamed')
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

test('modal navigation scrolls only its content and group grants stay independent', async () => {
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
    editor.navigate({ id: 'access', getBoundingClientRect: () => ({ top: 250 }) } as any)
    assert.equal(destination, 300)
    assert.equal(editor.activeSection, 'access')
    const connection = { id: 'one', name: 'One', type: 'ssh', group: 'group' }
    assert.equal(editor.grantedByGroup(connection), false)
    editor.permissions.groups.ids.push('group')
    assert.equal(editor.grantedByGroup(connection), true)
    assert.deepEqual(editor.permissions.connections.ids, [])
})
