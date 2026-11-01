import assert from 'node:assert/strict'
import { test } from 'node:test'
import '@angular/compiler'
import { ConfigSyncSettingsTabComponent } from '../src/components/configSyncSettingsTab.component'

function setup (host: string|null = null, token: string|null = null) {
    const calls: string[] = []
    const config = { store: { configSync: { host, token } } }
    const remote = {
        getUser: async () => { calls.push('user'); return {} },
        getConfigs: async () => { calls.push('configs'); return [{ id: 1, name: 'Example' }] },
    }
    const component = new ConfigSyncSettingsTabComponent(config as any, {} as any, remote as any, {} as any, {} as any, {} as any, {} as any)
    return { component, calls, config, remote }
}

test('an unconfigured sync page never makes requests and clears stale connection state', async () => {
    const { component, calls, config } = setup()
    await component.ngOnInit()
    assert.deepEqual(calls, [])
    component.connectionSuccessful = true
    component.connectionError = new Error('Previous failure')
    component.configs = []
    config.store.configSync.host = 'https://example.invalid'
    await component.testConnection()
    assert.deepEqual(calls, [])
    assert.equal(component.connectionSuccessful, null)
    assert.equal(component.connectionError, null)
    assert.equal(component.configs, null)
})

test('opening a configured sync page validates the connection and loads its list once', async () => {
    const { component, calls } = setup('https://example.invalid', 'test-only')
    await component.ngOnInit()
    assert.deepEqual(calls, ['user', 'configs'])
    assert.equal(component.connectionSuccessful, true)
    assert.equal(component.configs?.length, 1)
})

test('sync connection and list failures are displayed without unhandled rejections', async () => {
    const { component, remote } = setup('https://example.invalid', 'test-only')
    const error = new Error('Unavailable')
    remote.getUser = async () => { throw error }
    await component.ngOnInit()
    assert.equal(component.connectionSuccessful, false)
    assert.equal(component.connectionError, error)
    remote.getUser = async () => ({})
    remote.getConfigs = async () => { throw error }
    await component.testConnection()
    assert.equal(component.connectionSuccessful, false)
    assert.equal(component.connectionError, error)
    assert.equal(component.configs, null)
    await component.loadConfigs()
    assert.equal(component.connectionError, error)
})

test('a successful list reload restores the page after a previous list failure', async () => {
    const { component, remote } = setup('https://example.invalid', 'test-only')
    const getConfigs = remote.getConfigs
    remote.getConfigs = async () => { throw new Error('Temporary list failure') }
    await component.ngOnInit()
    assert.equal(component.connectionSuccessful, false)
    remote.getConfigs = getConfigs
    await component.loadConfigs()
    assert.equal(component.connectionSuccessful, true)
    assert.equal(component.connectionError, null)
    assert.equal(component.configs?.length, 1)
})
