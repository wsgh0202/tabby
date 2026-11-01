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

function deferred<T> () {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
    return { promise, resolve, reject }
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

test('a stale list success cannot replace a newer authentication failure', async () => {
    const { component, remote, config } = setup('https://example.invalid', 'old')
    const list = deferred<Array<{ id: number, name: string }>>()
    const started = deferred<void>()
    remote.getConfigs = () => { started.resolve(); return list.promise }
    const previous = component.testConnection()
    await started.promise
    const currentError = new Error('Current credentials rejected')
    config.store.configSync.token = 'new'
    remote.getUser = async () => { throw currentError }
    await component.testConnection()
    list.resolve([{ id: 1, name: 'Previous credentials' }])
    await previous
    assert.equal(component.connectionSuccessful, false)
    assert.equal(component.connectionError, currentError)
    assert.equal(component.configs, null)
})

test('a stale list failure cannot clear a newer successful connection', async () => {
    const { component, remote, config } = setup('https://example.invalid', 'old')
    const list = deferred<Array<{ id: number, name: string }>>()
    const started = deferred<void>()
    remote.getConfigs = () => { started.resolve(); return list.promise }
    const previous = component.testConnection()
    await started.promise
    const current = [{ id: 2, name: 'Current credentials' }]
    config.store.configSync.token = 'new'
    remote.getConfigs = async () => current
    await component.testConnection()
    list.reject(new Error('Previous list failed'))
    await previous
    assert.equal(component.connectionSuccessful, true)
    assert.equal(component.connectionError, null)
    assert.deepEqual(component.configs, current)
})

test('an obsolete authentication response cannot start another list request', async () => {
    const { component, remote, config } = setup('https://example.invalid', 'old')
    const user = deferred<object>()
    remote.getUser = () => user.promise
    const previous = component.testConnection()
    let listRequests = 0
    const current = [{ id: 2, name: 'Current credentials' }]
    config.store.configSync.token = 'new'
    remote.getUser = async () => ({})
    remote.getConfigs = async () => { listRequests++; return current }
    await component.testConnection()
    user.resolve({})
    await previous
    assert.equal(listRequests, 1)
    assert.equal(component.connectionSuccessful, true)
    assert.deepEqual(component.configs, current)
})

test('only the latest direct list reload can update state with unchanged credentials', async () => {
    const { component, remote } = setup('https://example.invalid', 'token')
    const list = deferred<Array<{ id: number, name: string }>>()
    remote.getConfigs = () => list.promise
    const previous = component.loadConfigs()
    const current = [{ id: 2, name: 'Latest list' }]
    remote.getConfigs = async () => current
    await component.loadConfigs()
    list.resolve([{ id: 1, name: 'Previous list' }])
    await previous
    assert.equal(component.connectionSuccessful, true)
    assert.deepEqual(component.configs, current)
})

for (const field of ['host', 'token'] as const) {
    test(`changing the ${field} invalidates a pending list response without another request`, async () => {
        for (const outcome of ['success', 'failure']) {
            const { component, remote, config } = setup('https://example.invalid', 'token')
            const list = deferred<Array<{ id: number, name: string }>>()
            remote.getConfigs = () => list.promise
            const pending = component.loadConfigs()
            config.store.configSync[field] = field === 'host' ? 'https://different.invalid' : 'changed'
            if (outcome === 'success') {
                list.resolve([{ id: 1, name: 'Previous credentials' }])
            } else {
                list.reject(new Error('Previous credentials failed'))
            }
            await pending
            assert.equal(component.connectionSuccessful, null, outcome)
            assert.equal(component.connectionError, null, outcome)
            assert.equal(component.configs, null, outcome)
        }
    })
}

test('normalizing a trailing host slash during the request keeps the response current', async () => {
    const { component, remote, config, calls } = setup('https://example.invalid/', 'token')
    remote.getUser = async () => {
        config.store.configSync.host = 'https://example.invalid'
        return {}
    }
    await component.testConnection()
    assert.deepEqual(calls, ['configs'])
    assert.equal(component.connectionSuccessful, true)
    assert.equal(component.connectionError, null)
    assert.equal(component.configs?.length, 1)
})
