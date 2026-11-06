import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Subject } from 'rxjs'
import ts from 'typescript'

// Load the actual connectable-tab methods without booting the Electron frontend.
const source = new URL('../src/api/connectableTerminalTab.component.ts', import.meta.url)
const requireSource = createRequire(source)
const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText
const exports: any = {}
runInNewContext(compiled, {
    exports,
    require: name => {
        if (name === './baseTerminalTab.component') { return { BaseTerminalTabComponent: class {} } }
        if (name === '@angular/core') { return { Component: () => () => undefined } }
        if (name === 'tabby-core') { return { ProfilesService: class {} } }
        return requireSource(name)
    },
})
const Tab = exports.ConnectableTerminalTabComponent

function fixture (mcp: boolean) {
    const tab = Object.create(Tab.prototype)
    const writes: string[] = []
    let reconnects = 0
    tab.mcpOrigin = mcp ? { sessionOpen: false } : null
    tab.reconnectOffered = false
    tab.input$ = new Subject<string>()
    tab.translate = { instant: text => text }
    tab.write = text => { writes.push(text) }
    tab.reconnect = () => { reconnects++ }
    return { tab, writes, reconnects: () => reconnects }
}

test('MCP tabs never offer or subscribe to press-any-key reconnection', () => {
    const { tab, writes, reconnects } = fixture(true)
    assert.equal(tab.canReconnect, false)
    tab.offerReconnection()
    tab.input$.next('x')
    assert.deepEqual(writes, [])
    assert.equal(tab.reconnectOffered, false)
    assert.equal(tab.input$.observed, false)
    assert.equal(reconnects(), 0)
})

test('ordinary tabs still offer reconnection and reconnect on the first key only', () => {
    const { tab, writes, reconnects } = fixture(false)
    assert.equal(tab.canReconnect, true)
    tab.offerReconnection()
    tab.offerReconnection()
    assert.deepEqual(writes, ['Press any key to reconnect\r\n'])
    tab.input$.next('x')
    tab.input$.next('y')
    assert.equal(reconnects(), 1)
})

test('direct MCP reconnect calls cannot destroy, initialize or replace the managed session', async () => {
    const { tab } = fixture(true)
    const unexpected = () => assert.fail('MCP reconnection must stop before touching the session')
    tab.session = { open: false, destroy: unexpected }
    tab.frontend = { resetTerminalModes: unexpected }
    tab.initializeSession = unexpected
    tab.injector = { get: unexpected }
    await Tab.prototype.reconnect.call(tab)
    assert.ok(tab.mcpOrigin)
})
