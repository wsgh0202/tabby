import assert from 'node:assert/strict'
import test from 'node:test'
import { requestAgentIdentities } from '../src/session/agentIdentities.ts'
import type { AgentIdentityStream } from '../src/session/agentIdentities.ts'

function uint32 (value: number): Buffer {
    const result = Buffer.alloc(4)
    result.writeUInt32BE(value)
    return result
}

function string (value: string|Buffer): Buffer {
    const bytes = Buffer.from(value)
    return Buffer.concat([uint32(bytes.length), bytes])
}

function frame (payload: Buffer): Buffer {
    return Buffer.concat([uint32(payload.length), payload])
}

const keyBlob = Buffer.concat([string('ssh-ed25519'), string(Buffer.alloc(32, 1))])
const publicKey = `ssh-ed25519 ${keyBlob.toString('base64')}`

function identitiesResponse (names: string[]): Buffer {
    return frame(Buffer.concat([
        Buffer.from([12]),
        uint32(names.length),
        ...names.flatMap(name => [string(keyBlob), string(name)]),
    ]))
}

class FakeAgentStream implements AgentIdentityStream {
    observer: Parameters<AgentIdentityStream['data$']['subscribe']>[0]|null = null
    writes: Uint8Array[] = []
    subscriptions = 0
    onWrite: () => void|Promise<void> = () => undefined
    onSubscribe: () => void = () => undefined

    data$ = {
        subscribe: (observer: Parameters<AgentIdentityStream['data$']['subscribe']>[0]) => {
            this.observer = observer
            this.subscriptions++
            this.onSubscribe()
            return {
                unsubscribe: () => {
                    this.subscriptions--
                    this.observer = null
                },
            }
        },
    }

    async write (data: Uint8Array): Promise<void> {
        assert.ok(this.observer, 'subscribe before requesting identities')
        this.writes.push(data)
        await this.onWrite()
    }
}

test('lists named public keys without making authentication requests', async () => {
    const stream = new FakeAgentStream()
    stream.onWrite = () => stream.observer?.next(identitiesResponse(['first', '服务器密钥', 'last']))

    assert.deepEqual(await requestAgentIdentities(stream), [
        { publicKey, comment: 'first' },
        { publicKey, comment: '服务器密钥' },
        { publicKey, comment: 'last' },
    ])
    assert.deepEqual(stream.writes, [Buffer.from([0, 0, 0, 1, 11])])
    assert.equal(stream.subscriptions, 0)
})

test('reassembles fragmented headers and bodies', async () => {
    const stream = new FakeAgentStream()
    stream.onWrite = () => {
        const response = identitiesResponse(['name'])
        for (const byte of response) {
            stream.observer?.next(Buffer.from([byte]))
        }
    }

    assert.deepEqual(await requestAgentIdentities(stream), [{ publicKey, comment: 'name' }])
    assert.equal(stream.subscriptions, 0)
})

test('accepts an empty identities list', async () => {
    const stream = new FakeAgentStream()
    stream.onWrite = () => stream.observer?.next(identitiesResponse([]))

    assert.deepEqual(await requestAgentIdentities(stream), [])
    assert.equal(stream.subscriptions, 0)
})

test('rejects refusals and malformed identities responses', async () => {
    const cases = [
        frame(Buffer.from([5])),
        uint32(0),
        uint32(1024 * 1024 + 1),
        frame(Buffer.from([12])),
        frame(Buffer.concat([Buffer.from([12]), uint32(1), uint32(100)])),
        frame(Buffer.concat([Buffer.from([12]), uint32(1), string(Buffer.alloc(0)), string('name')])),
        frame(Buffer.concat([Buffer.from([12]), uint32(1), string(uint32(100)), string('name')])),
        frame(Buffer.concat([Buffer.from([12]), uint32(0), Buffer.from([0])])),
        Buffer.concat([identitiesResponse([]), Buffer.from([0])]),
    ]
    for (const response of cases) {
        const stream = new FakeAgentStream()
        stream.onWrite = () => stream.observer?.next(response)

        await assert.rejects(requestAgentIdentities(stream), /SSH agent/)
        assert.equal(stream.subscriptions, 0)
    }
})

test('bounds accumulated response data before copying it', async () => {
    const stream = new FakeAgentStream()
    stream.onWrite = () => stream.observer?.next(Buffer.alloc(1024 * 1024 + 5))

    await assert.rejects(requestAgentIdentities(stream), /too large/)
    assert.equal(stream.subscriptions, 0)
})

test('cleans up when the agent closes during a response', async () => {
    const stream = new FakeAgentStream()
    stream.onWrite = () => {
        stream.observer?.next(Buffer.from([0, 0]))
        stream.observer?.complete()
    }

    await assert.rejects(requestAgentIdentities(stream), /closed/)
    assert.equal(stream.subscriptions, 0)
})

test('cleans up when the stream is already closed', async () => {
    const stream = new FakeAgentStream()
    stream.onSubscribe = () => stream.observer?.complete()

    await assert.rejects(requestAgentIdentities(stream), /closed/)
    assert.deepEqual(stream.writes, [])
    assert.equal(stream.subscriptions, 0)
})

test('cleans up when listing identities times out', async () => {
    const stream = new FakeAgentStream()

    await assert.rejects(requestAgentIdentities(stream, 5), /Timed out/)
    assert.equal(stream.subscriptions, 0)
})

test('cleans up after write failures and stream errors', async () => {
    for (const writeFailure of [true, false]) {
        const stream = new FakeAgentStream()
        stream.onWrite = () => {
            if (writeFailure) {
                throw new Error('write failed')
            }
            stream.observer?.error(new Error('stream failed'))
        }

        await assert.rejects(requestAgentIdentities(stream), /failed/)
        assert.equal(stream.subscriptions, 0)
    }
})
