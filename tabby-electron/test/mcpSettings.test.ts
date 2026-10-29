import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MCPSettingsTabComponent } from '../src/components/mcpSettingsTab.component'
import { newMCPPermissions } from '../src/mcp/access'

function setup () {
    const calls: any[] = []
    const mcp = {
        settings: { enabled: false, port: null as number|null, lastRandomPort: null as number|null },
        refresh: async () => { calls.push('refresh') },
        getCatalog: async () => ({ groups: [], connections: [] }),
        createToken: async (name, permissions) => { calls.push({ name, permissions }); return 'plaintext-once' },
        updateToken: async (id, permissions) => { calls.push({ id, permissions }) },
    }
    const config = { fail: false, save: async () => { if (config.fail) { throw new Error('Write failed') }; calls.push('save') } }
    const component = new MCPSettingsTabComponent(mcp as any, {} as any, config as any, { setClipboard: content => calls.push(content) } as any)
    return { component, mcp, config, calls }
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
    const { component, calls } = setup()
    await component.openEditor()
    component.name = 'Agent'
    component.toggleSelection(component.permissions.tools, 'list_connections', true)
    component.toggleSelection(component.permissions.connections.ids, 'one', true)
    await component.saveToken()
    assert.equal(component.editorOpen, false)
    assert.equal(component.createdToken, 'plaintext-once')
    component.copy(component.createdToken!)
    assert.deepEqual(calls[1], { text: 'plaintext-once' })
    component.ngOnDestroy()
    assert.equal(component.createdToken, null)
})

test('editing clones permissions and supports removing independent selections', async () => {
    const { component, calls } = setup()
    const token = { ...newMCPPermissions(), id: 'id', name: 'Agent' }
    token.groups.ids = ['group']
    await component.openEditor(token)
    component.toggleSelection(component.permissions.groups.ids, 'group', false)
    assert.deepEqual(token.groups.ids, ['group'])
    await component.saveToken()
    assert.equal(component.createdToken, null)
    assert.equal(calls[0].id, 'id')
    assert.deepEqual(calls[0].permissions.groups.ids, [])
})
