import assert from 'node:assert/strict'
import { test } from 'node:test'
import '@angular/compiler'
import { preventOverflow } from '@popperjs/core'
import { MCPCatalog, newMCPPermissions } from '../src/mcp/access'
import { MCPConnectionEditor } from '../src/mcp/connectionEditor'
import { MCPConnectionsModalComponent } from '../src/components/mcpConnectionsModal.component'
import { MCPTokenModalComponent } from '../src/components/mcpTokenModal.component'
import { MCPCapabilityHelpComponent } from '../src/components/mcpCapabilityHelp.component'

const catalog: MCPCatalog = {
    groups: [
        { id: 'root', name: 'Development' },
        { id: 'child', name: 'Backend', parentId: 'root' },
        { id: 'nested', name: 'API', parentId: 'child' },
        { id: 'other', name: 'Production' },
    ],
    connections: [
        { id: 'one', name: 'One', type: 'ssh', group: 'root' },
        { id: 'two', name: 'Two', type: 'ssh', group: 'child' },
        { id: 'three', name: 'Three', type: 'ssh', group: 'nested' },
        { id: 'four', name: 'Four', type: 'ssh', group: 'other' },
    ],
}

function setup () {
    const permissions = newMCPPermissions()
    permissions.capabilities = ['connection_operations']
    permissions.groups.root = { view_config: true, access: true }
    permissions.groups.child = { view_config: false }
    permissions.connections.one = { included: true, overrides: { upload: true } }
    permissions.connections.two = { included: false, overrides: { access: false } }
    permissions.connections.three = { included: true, overrides: { download: false } }
    permissions.connections.four = { included: true, overrides: { access: true } }
    return new MCPConnectionEditor(permissions, catalog)
}

test('scope counts include descendants and stay independent from capabilities', () => {
    const editor = setup()
    assert.equal(editor.connectionsInGroup('root').length, 3)
    assert.equal(editor.includedConnections('root').length, 2)
    assert.equal(editor.includedConnections('child').length, 1)
    const group = editor.rows[0]
    assert.equal(editor.partiallySelected(group), true)
    editor.setIncluded(group, true)
    assert.equal(editor.includedConnections('root').length, 3)
    assert.deepEqual(editor.permissions.connections.two.overrides, { access: false })
    editor.setIncluded(group, false)
    assert.equal(editor.includedConnections('root').length, 0)
    assert.equal(editor.permissions.groups.root.access, true)
    assert.deepEqual(editor.permissions.connections.one.overrides, { upload: true })
    assert.equal(editor.included('four'), true)
})

test('each subgroup and leaf capability cycles inherited, enabled, disabled, inherited', () => {
    const editor = setup()
    const subgroup = editor.rows.find(row => row.id === 'nested')!
    const connection = editor.rows.find(row => row.id === 'three')!
    assert.equal(editor.inherited(subgroup, 'access'), true)
    assert.equal(editor.effective(subgroup, 'access'), true)
    editor.cycle(subgroup, 'access')
    assert.equal(editor.inherited(subgroup, 'access'), false)
    assert.equal(editor.effective(subgroup, 'access'), true)
    editor.cycle(subgroup, 'access')
    assert.equal(editor.effective(subgroup, 'access'), false)
    assert.equal(editor.effective(connection, 'access'), false, 'a connection follows its direct group')
    editor.cycle(subgroup, 'access')
    assert.equal(editor.inherited(subgroup, 'access'), true)
    assert.equal(editor.effective(connection, 'access'), true)
    editor.cycle(connection, 'view_config')
    assert.equal(editor.effective(connection, 'view_config'), true)
    editor.cycle(connection, 'view_config')
    assert.equal(editor.effective(connection, 'view_config'), false)
    editor.cycle(connection, 'view_config')
    assert.equal(editor.inherited(connection, 'view_config'), true)
    assert.equal(editor.effective(connection, 'view_config'), false, 'the direct group inherits a disabled parent override')
    assert.deepEqual(editor.permissions.connections.three.overrides, { download: false })
})

test('root group controls have two states and search preserves ancestor navigation', () => {
    const editor = setup()
    const root = editor.rows[0]
    assert.equal(editor.inherited(root, 'access'), false)
    editor.cycle(root, 'access')
    assert.equal(editor.effective(root, 'access'), false)
    editor.cycle(root, 'access')
    assert.equal(editor.effective(root, 'access'), true)
    editor.collapsedNavigation.add('root')
    editor.search = 'API'
    assert.deepEqual(editor.navigation.map(entry => [entry.group.id, entry.depth]), [['root', 0], ['child', 1], ['nested', 2]])
    editor.search = ''
    assert.deepEqual(editor.navigation.map(entry => entry.group.id), ['root', 'other'])
})

test('cyclic branches remain searchable beside valid roots without revealing collapsed normal children', () => {
    const permissions = newMCPPermissions()
    permissions.groups.a = { access: true }
    permissions.connections.cyclic = { included: true, overrides: { access: true } }
    permissions.connections.regular = { included: true, overrides: {} }
    const editor = new MCPConnectionEditor(permissions, {
        groups: [
            { id: 'built-in', name: 'Built-in' },
            { id: 'normal', name: 'Normal', parentId: 'built-in' },
            { id: 'hidden', name: 'Hidden child', parentId: 'normal' },
            // The first disconnected item can be a descendant of the cycle.
            { id: 'cycle-child', name: 'Cycle child', parentId: 'a' },
            { id: 'a', name: 'Loop A', parentId: 'b' },
            { id: 'b', name: 'Loop B', parentId: 'a' },
        ],
        connections: [
            { id: 'cyclic', name: 'Cyclic connection', type: 'ssh', group: 'a' },
            { id: 'regular', name: 'Regular connection', type: 'ssh', group: 'hidden' },
        ],
    })
    editor.collapsedNavigation.add('normal')
    assert.deepEqual(editor.navigation.map(entry => entry.group.id), ['built-in', 'normal', 'b', 'a', 'cycle-child'])
    assert.equal(editor.includedConnections('a').length, 1)
    assert.equal(editor.includedConnections('b').length, 1)
    assert.equal(editor.includedConnections('built-in').length, 1)
    editor.search = 'Loop A'
    assert.deepEqual(editor.navigation.map(entry => entry.group.id), ['b', 'a', 'cycle-child'])
    editor.selectedGroupId = 'a'
    const connection = editor.rows.find(row => row.connection?.id === 'cyclic')!
    assert.equal(editor.effective(connection, 'access'), false, 'displaying damaged ancestry never grants access')
    editor.setIncluded(connection, false)
    assert.equal(editor.includedConnections('a').length, 0)
    assert.equal(editor.includedConnections('b').length, 0)
    assert.equal(editor.included('regular'), true)
    editor.search = ''
    assert.equal(editor.navigation.some(entry => entry.group.id === 'hidden'), false)
    assert.equal(editor.collapsedNavigation.has('normal'), true)
    editor.collapsedNavigation.add('b')
    assert.deepEqual(editor.navigation.map(entry => entry.group.id), ['built-in', 'normal', 'b'])
})

test('scope reset affects only included connection overrides and row reset can clear excluded overrides', () => {
    const editor = setup()
    const templates = JSON.stringify(editor.permissions.groups)
    assert.equal(editor.canReset, true)
    editor.resetIncluded()
    assert.equal(editor.canReset, false)
    assert.deepEqual(editor.permissions.connections.one, { included: true, overrides: {} })
    assert.deepEqual(editor.permissions.connections.three, { included: true, overrides: {} })
    assert.deepEqual(editor.permissions.connections.two, { included: false, overrides: { access: false } })
    assert.deepEqual(editor.permissions.connections.four.overrides, { access: true })
    editor.resetConnection('two')
    assert.deepEqual(editor.permissions.connections.two, { included: false, overrides: {} })
    assert.equal(JSON.stringify(editor.permissions.groups), templates)
})

test('batch writes all five explicit values to its target snapshot without changing templates or inclusion', () => {
    const editor = setup()
    const targets = editor.includedConnections().map(connection => connection.id)
    const templates = JSON.stringify(editor.permissions.groups)
    editor.permissions.connections.two.included = true
    editor.applyBatch(targets, ['access', 'download'])
    assert.deepEqual(editor.permissions.connections.one.overrides, { view_config: false, edit_config: false, access: true, upload: false, download: true })
    assert.deepEqual(editor.permissions.connections.three.overrides, editor.permissions.connections.one.overrides)
    assert.deepEqual(editor.permissions.connections.two.overrides, { access: false }, 'a connection included after opening is outside the snapshot')
    assert.deepEqual(editor.permissions.connections.four.overrides, { access: true })
    assert.equal(JSON.stringify(editor.permissions.groups), templates)
})

test('connection draft is isolated and nested batch cancellation preserves the parent editor and scroll state', async () => {
    let batch: any
    let rejectBatch
    const ngbModal = { open: () => ({
        componentInstance: batch = {},
        result: new Promise((_resolve, reject) => { rejectBatch = reject }),
    }) }
    const parent = setup()
    const component = new MCPConnectionsModalComponent({} as any, ngbModal as any)
    component.permissions = parent.permissions
    component.catalog = catalog
    component.ngOnInit()
    component.editor.selectedGroupId = 'child'
    component.editor.search = 'Backend'
    component.editor.permissions.groups.child.upload = true
    const editorBefore = component.editor
    const draftBefore = JSON.stringify(component.editor.permissions)
    const result = component.openBatch()
    assert.deepEqual(batch.connections.map(connection => connection.id), ['three'])
    rejectBatch('cancel')
    await result
    assert.equal(component.editor, editorBefore, 'the parent view is not replaced during batch editing')
    assert.equal(component.editor.selectedGroupId, 'child')
    assert.equal(component.editor.search, 'Backend')
    assert.equal(JSON.stringify(component.editor.permissions), draftBefore)
    assert.equal(parent.permissions.groups.child.upload, undefined, 'cancelled connection edits never reach the token')
    assert.equal(component.batchOpen, false)
})

test('connection configuration is copied to the token draft only on confirm', async () => {
    let resolveChild, rejectChild
    let child: any
    const ngbModal = { open: () => ({
        componentInstance: child = {},
        result: new Promise((resolve, reject) => { resolveChild = resolve; rejectChild = reject }),
    }) }
    const component = new MCPTokenModalComponent({} as any, {} as any, ngbModal as any)
    component.ngOnInit()
    component.setConnectionOperations(true)
    const original = component.permissions
    const first = component.configureConnections()
    assert.equal(child.permissions, original)
    rejectChild('escape')
    await first
    assert.equal(component.permissions, original)
    const confirmed = setup().permissions
    const second = component.configureConnections()
    resolveChild(confirmed)
    await second
    assert.equal(component.permissions, confirmed)
})

test('single-row reset clears retained overrides and moves focus to its inclusion checkbox', () => {
    const component = new MCPConnectionsModalComponent({} as any, {} as any)
    component.editor = setup()
    let focused = false
    component.resetRow('two', { focus: () => { focused = true } } as any)
    assert.deepEqual(component.editor.permissions.connections.two, { included: false, overrides: {} })
    assert.equal(focused, true)
})

test('capability help supports pinned state and captures Escape before the modal', () => {
    const listeners: any[] = []
    const document = { addEventListener: (...args) => listeners.push(args), removeEventListener: (...args) => listeners.push(args) }
    const component = new MCPCapabilityHelpComponent({ nativeElement: {} } as any, document as any)
    let open = false
    component.popover = { open: () => { open = true }, close: () => { open = false }, isOpen: () => open } as any
    component.ngOnInit()
    assert.deepEqual([listeners[0][0], listeners[0][2]], ['keydown', true])
    component.open()
    assert.equal(open, true)
    component.togglePinned()
    assert.equal(component.pinned, true)
    component.leave()
    assert.equal(open, true)
    let prevented = false
    let stopped = false
    component.handleEscape({ key: 'Escape', preventDefault: () => { prevented = true }, stopImmediatePropagation: () => { stopped = true } } as any)
    assert.equal(open, false)
    assert.equal(component.pinned, false)
    assert.equal(prevented, true)
    assert.equal(stopped, true)
    stopped = false
    component.handleEscape({ key: 'Escape', preventDefault: () => {}, stopImmediatePropagation: () => { stopped = true } } as any)
    assert.equal(stopped, false, 'the next Escape reaches the modal after help has closed')
    component.ngOnDestroy()
    assert.equal(listeners.length, 4)
})

test('pinned help ignores its opening click and clicks inside its popover but closes outside', () => {
    const trigger = {}
    const content = {}
    const outside = {}
    const element = { nativeElement: {
        contains: target => target === trigger,
        querySelector: () => ({ getAttribute: () => 'help-popover' }),
    } }
    const document = { getElementById: () => ({ contains: target => target === content }) }
    const component = new MCPCapabilityHelpComponent(element as any, document as any)
    let open = false
    component.popover = { open: () => { open = true }, close: () => { open = false }, isOpen: () => open } as any
    component.togglePinned()
    component.handleOutsideClick({ target: trigger } as any)
    assert.equal(open, true)
    assert.equal(component.pinned, true)
    component.handleOutsideClick({ target: content } as any)
    assert.equal(open, true)
    component.handleOutsideClick({ target: outside } as any)
    assert.equal(open, false)
    assert.equal(component.pinned, false)
})

test('capability help constrains Popper to the active modal viewport', () => {
    const dialog = { getBoundingClientRect: () => ({ width: 300, height: 240 }) }
    const component = new MCPCapabilityHelpComponent({ nativeElement: { closest: () => dialog } } as any, {} as any)
    // Ng-bootstrap supplies a no-op with the same name before applying our options.
    const options = component.popperOptions({ modifiers: [{ name: 'preventOverflow', enabled: true, phase: 'main', fn: () => {} }] })
    const overflow = options.modifiers!.filter(modifier => modifier.name === 'preventOverflow').pop()!
    assert.equal(overflow.fn, preventOverflow.fn, 'restore the real boundary constraint')
    assert.equal(overflow.options!.boundary, dialog)
    assert.equal(overflow.options!.tether, false, 'a clipped trigger must not pull help outside the modal')
    const size = options.modifiers!.find(modifier => modifier.name === 'mcpSize')!
    const state = { styles: { popper: {} as any } }
    size.fn!({ state } as any)
    assert.equal(state.styles.popper.maxWidth, 'min(23.75rem, 284px)')
    assert.equal(state.styles.popper.maxHeight, '224px')
    assert.equal(state.styles.popper.overflowY, undefined, 'the external arrow must not become scrollable content')
})
