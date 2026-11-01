import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SSHSessionCleanup } from '../src/session/sessionCleanup'

function setup () {
    let announced = 0
    let failures = 0
    const cleanup = new SSHSessionCleanup(() => { announced++ }, () => { failures++ })
    return { cleanup, announced: () => announced, failures: () => failures }
}

test('repeated and concurrent SSH cleanup shares one native disconnect', async () => {
    const fixture = setup()
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const client = { disconnect: async () => { calls++; await gate } }
    const first = fixture.cleanup.disconnect(client)
    const concurrent = fixture.cleanup.disconnect(client)
    assert.equal(first, concurrent)
    await Promise.resolve()
    assert.equal(calls, 1)
    release()
    await Promise.all([first, concurrent])
    await fixture.cleanup.disconnect(client)
    assert.equal(calls, 1)
    assert.equal(fixture.announced(), 1)
    assert.equal(fixture.failures(), 0)
})

test('a rejected native disconnect is handled and is not retried', async () => {
    const fixture = setup()
    let calls = 0
    const client = { disconnect: async () => { calls++; throw new Error('SendError') } }
    await fixture.cleanup.disconnect(client)
    await fixture.cleanup.disconnect(client)
    assert.equal(calls, 1)
    assert.equal(fixture.failures(), 1)
    assert.equal(fixture.announced(), 1)
})

test('synchronously thrown disconnect failures are handled too', async () => {
    const fixture = setup()
    const client = { disconnect: (): Promise<void> => { throw new Error('Native handle closed') } }
    await fixture.cleanup.disconnect(client)
    assert.equal(fixture.failures(), 1)
})

test('early cleanup still disconnects late and replacement SSH clients', async () => {
    const fixture = setup()
    let calls = 0
    const first = { disconnect: async () => { calls++ } }
    const replacement = { disconnect: async () => { calls++ } }
    await fixture.cleanup.disconnect()
    await fixture.cleanup.disconnect(first)
    await fixture.cleanup.disconnect(replacement)
    await fixture.cleanup.disconnect(first)
    assert.equal(calls, 2)
    assert.equal(fixture.announced(), 1)
    assert.equal(fixture.failures(), 0)
})

test('reentrant willDestroy callbacks do not repeat notification or native disconnect', async () => {
    let announced = 0
    let calls = 0
    let reentrant: Promise<void>|undefined
    const client = { disconnect: async () => { calls++ } }
    const cleanup = new SSHSessionCleanup(() => {
        announced++
        reentrant = cleanup.disconnect(client)
    }, () => assert.fail('disconnect should succeed'))
    await cleanup.disconnect(client)
    await reentrant
    assert.equal(announced, 1)
    assert.equal(calls, 1)
})

test('a client arriving after an earlier disconnect failure is still cleaned up', async () => {
    const fixture = setup()
    let lateCalls = 0
    await fixture.cleanup.disconnect({ disconnect: async () => { throw new Error('SendError') } })
    await fixture.cleanup.disconnect({ disconnect: async () => { lateCalls++ } })
    assert.equal(lateCalls, 1)
    assert.equal(fixture.failures(), 1)
})
