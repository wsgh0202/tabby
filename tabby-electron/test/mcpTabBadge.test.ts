import assert from 'node:assert/strict'
import { test } from 'node:test'
import '@angular/compiler'
import { MCPTabBadgeComponent } from '../../tabby-core/src/components/mcpTabBadge.component'

test('split tab badge stays open while any MCP session is open and follows live state', () => {
    const badge = new MCPTabBadgeComponent()
    const origin = { tokenName: 'Agent', source: '', connectionName: 'Shell', connectionType: 'local', sessionId: 'one', sessionOpen: true }
    const other = { ...origin, sessionId: 'two', sessionOpen: false }
    badge.origins = [origin, other]
    assert.equal(badge.sessionOpen, true)
    origin.sessionOpen = false
    assert.equal(badge.sessionOpen, false)
    other.sessionOpen = true
    assert.equal(badge.sessionOpen, true)
    badge.origins = []
    assert.equal(badge.sessionOpen, false)
})

test('MCP origin popover bridges the hover gap and stays open while selecting inside', context => {
    const pending = new Map<number, () => void>()
    let timerId = 0
    context.mock.method(globalThis, 'setTimeout', callback => { pending.set(++timerId, callback); return timerId as any })
    context.mock.method(globalThis, 'clearTimeout', id => { pending.delete(Number(id)) })
    const badge = new MCPTabBadgeComponent()
    let opened = false
    badge.popover = { open: () => { opened = true }, close: () => { opened = false; badge.hidden() } } as any
    badge.open()
    badge.leave()
    assert.equal(pending.size, 1)
    badge.insideDetails = true
    badge.cancelClose()
    badge.focused = false
    badge.leave()
    assert.equal(pending.size, 0, 'moving into the details cancels delayed dismissal')
    assert.equal(opened, true)
    badge.insideDetails = false
    badge.leave()
    const close = [...pending.values()][0]
    close()
    assert.equal(opened, false)
    badge.ngOnDestroy()
})

test('MCP origin supports keyboard focus, pinning, outside dismissal and timer cleanup', context => {
    const scheduled: (() => void)[] = []
    const cleared: unknown[] = []
    context.mock.method(globalThis, 'setTimeout', callback => { scheduled.push(callback); return scheduled.length as any })
    context.mock.method(globalThis, 'clearTimeout', id => { cleared.push(id) })
    const badge = new MCPTabBadgeComponent()
    let closes = 0
    badge.popover = { open: () => undefined, close: () => { closes++; badge.hidden() } } as any
    badge.focused = true
    badge.open()
    badge.leave()
    assert.equal(scheduled.length, 0)
    badge.focused = false
    badge.togglePinned()
    badge.leave()
    assert.equal(scheduled.length, 0)
    badge.focused = true
    badge.hidden()
    assert.equal(badge.pinned, false)
    assert.equal(badge.focused, false, 'removing the focused details must not keep the next hover pinned')
    badge.leave()
    badge.ngOnDestroy()
    assert.equal(cleared.length, 1)
    assert.equal(closes, 1)
})
