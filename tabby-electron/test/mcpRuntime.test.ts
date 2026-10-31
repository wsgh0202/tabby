import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { Subject } from 'rxjs'
import { MCPRuntime, MCPSessionCallbacks, MCP_MAX_FILE_BYTES, decodeMCPFile, publicMCPProfile, readMCPFileChunks, updateMCPProfile, validateMCPFilePath } from '../src/mcp/runtime'
import { MCPConnectionsService } from '../src/services/mcpConnections.service'

function sessionFixture (options = {}) {
    const runtime = new MCPRuntime({ sweepInterval: 0, ...options })
    let callbacks: MCPSessionCallbacks
    let allowed = true
    let closes = 0
    const inputs: string[] = []
    const create = async (value: MCPSessionCallbacks) => {
        callbacks = value
        return { open: true, write: (input: string) => inputs.push(input), close: async () => { closes++ } }
    }
    const open = () => runtime.open('token', 'connection', create, async () => allowed)
    return { runtime, open, inputs, output: (value: Buffer|string) => callbacks.output(Buffer.from(value)), setAllowed: (value: boolean) => { allowed = value }, closes: () => closes }
}

test('terminal sessions isolate bearer ownership and connection identities', async () => {
    const fixture = sessionFixture()
    const { sessionId } = await fixture.open()
    await assert.rejects(fixture.runtime.read('another-token', 'connection', sessionId), /not found/)
    await assert.rejects(fixture.runtime.write('token', 'another-connection', sessionId, 'input'), /not found/)
    await fixture.runtime.write('token', 'connection', sessionId, 'hello\r')
    assert.deepEqual(fixture.inputs, ['hello\r'])
    await fixture.runtime.close('token', 'connection', sessionId)
    assert.equal(fixture.closes(), 1)
    await assert.rejects(fixture.runtime.read('token', 'connection', sessionId), /not found/)
})

test('terminal reads preserve UTF-8 across input chunks, byte cursors and small reads', async () => {
    const fixture = sessionFixture()
    const { sessionId } = await fixture.open()
    const utf8 = Buffer.from('中🙂x')
    fixture.output(utf8.subarray(0, 2))
    fixture.output(utf8.subarray(2, 5))
    fixture.output(utf8.subarray(5))
    const first: any = await fixture.runtime.read('token', 'connection', sessionId, 0, 1)
    assert.deepEqual(first, { output: '中', cursor: 3, hasMore: true, truncated: false, open: true })
    const second: any = await fixture.runtime.read('token', 'connection', sessionId, first.cursor, 1)
    assert.equal(second.output, '🙂')
    assert.equal(second.cursor, 7)
    const last: any = await fixture.runtime.read('token', 'connection', sessionId, second.cursor)
    assert.equal(last.output, 'x')
    assert.equal(last.cursor, 8)
    assert.equal(last.hasMore, false)
    await fixture.runtime.disposeAll()
})

test('bounded output reports truncation and output does not renew the idle lease', async () => {
    let now = 0
    const fixture = sessionFixture({ now: () => now, idleTimeout: 100, outputLimit: 4 })
    const { sessionId } = await fixture.open()
    fixture.output('a中文b')
    const result: any = await fixture.runtime.read('token', 'connection', sessionId)
    assert.deepEqual(result, { output: '文b', cursor: 8, hasMore: false, truncated: true, open: true })
    now = 90
    fixture.output('new output')
    now = 100
    await fixture.runtime.sweep()
    assert.equal(fixture.closes(), 1)
    await assert.rejects(fixture.runtime.read('token', 'connection', sessionId), /not found/)
})

test('revocation is rechecked before output and input, and closes the owned terminal', async () => {
    const fixture = sessionFixture()
    const { sessionId } = await fixture.open()
    fixture.output('secret output')
    fixture.setAllowed(false)
    await assert.rejects(fixture.runtime.read('token', 'connection', sessionId), /denied/)
    assert.equal(fixture.closes(), 1)
    assert.deepEqual(fixture.inputs, [])
})

test('disposal during asynchronous open closes a session created after revocation', async () => {
    const runtime = new MCPRuntime({ sweepInterval: 0 })
    let release: () => void
    let started: () => void
    let closes = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { started = resolve })
    const opening = runtime.open('token', 'connection', async () => {
        started()
        await gate
        return { open: true, write: () => undefined, close: async () => { closes++ } }
    }, async () => true)
    await ready
    await runtime.disposeToken('token')
    release!()
    await assert.rejects(opening, /denied/)
    assert.equal(closes, 1)
})

test('session count and terminal input limits prevent unbounded retained resources', async () => {
    const fixture = sessionFixture()
    const sessions = await Promise.all(Array.from({ length: 8 }, () => fixture.open()))
    await assert.rejects(fixture.open(), /limit/)
    await assert.rejects(fixture.runtime.write('token', 'connection', sessions[0].sessionId, '中'.repeat(30000)), /64 KiB/)
    await fixture.runtime.disposeToken('token')
    assert.equal(fixture.closes(), 8)
})

test('file payloads accept arbitrary bytes and enforce canonical base64 and decoded size', () => {
    const bytes = Buffer.from([0, 255, 3, 128, 13, 10])
    assert.deepEqual(decodeMCPFile(bytes.toString('base64')), bytes)
    assert.deepEqual(decodeMCPFile(''), Buffer.alloc(0))
    for (const invalid of ['Zg', 'Zh==', 'Zg==\n', '-_==', '====', 23]) {
        assert.throws(() => decodeMCPFile(invalid), /canonical base64/)
    }
    const maximum = Buffer.alloc(MCP_MAX_FILE_BYTES, 255)
    assert.equal(decodeMCPFile(maximum.toString('base64')).length, MCP_MAX_FILE_BYTES)
    assert.throws(() => decodeMCPFile(Buffer.alloc(MCP_MAX_FILE_BYTES + 1).toString('base64')), /4 MiB/)
    assert.throws(() => validateMCPFilePath('file\0name'), /Invalid/)
})

test('SFTP chunk reads reject file growth and recheck permission before releasing data', async () => {
    const chunks = [Buffer.alloc(MCP_MAX_FILE_BYTES), Buffer.from([1]), Buffer.alloc(0)]
    await assert.rejects(readMCPFileChunks(async () => chunks.shift()!, async () => true), /4 MiB/)
    let allowed = true
    let reads = 0
    await assert.rejects(readMCPFileChunks(async () => {
        reads++
        allowed = false
        return Buffer.from('secret')
    }, async () => allowed), /denied/)
    assert.equal(reads, 1)
})

test('configuration views use explicit provider fields and exclude stored secrets', () => {
    const profile = { id: 'ssh', type: 'ssh', name: 'Server', options: { host: 'example.test', port: 22, password: 'SECRET', privateKeys: ['PRIVATE'], env: { SECRET: 'secret' }, unknown: 'secret' } }
    const result: any = publicMCPProfile(profile)
    assert.deepEqual(result.options, { host: 'example.test', port: 22 })
    assert.ok(!JSON.stringify(result).includes('SECRET'))
    assert.deepEqual((publicMCPProfile({ ...profile, type: 'unknown' }) as any).options, {})
    assert.deepEqual((publicMCPProfile({ ...profile, type: 'local', options: { cwd: '/home', command: 'secret', args: ['secret'], env: { key: 'secret' } } }) as any).options, { cwd: '/home' })
})

test('configuration changes preserve identity and credentials while rejecting unsafe fields', () => {
    const original = { id: 'ssh', type: 'ssh', name: 'Server', group: 'group', options: { host: 'old', password: 'SECRET' } }
    const updated = updateMCPProfile(original, { name: 'New', options: { host: 'new', port: 2222 } })
    assert.equal(updated.id, original.id)
    assert.equal(updated.group, original.group)
    assert.equal(updated.options!.password, 'SECRET')
    assert.equal(original.options.host, 'old')
    for (const changes of [{ group: 'other' }, { type: 'local' }, { options: { password: 'new' } }, { options: { port: -1 } }, JSON.parse('{"options":{"__proto__":{"polluted":true}}}')]) {
        assert.throws(() => updateMCPProfile(original, changes))
    }
    assert.throws(() => updateMCPProfile({ ...original, isBuiltin: true }, { name: 'New' }), /read-only/)
})

function adapterFixture (profile: any, ready = true, Service = MCPConnectionsService) {
    let saved = structuredClone(profile)
    const opened: any[] = []
    const config = { save: async () => undefined }
    const profiles = {
        getProfiles: async () => [structuredClone(saved)],
        getConfigProxyForProfile: value => value,
        writeProfile: async value => { saved = structuredClone(value) },
        newTabParametersForProfile: async value => ({ inputs: { profile: value } }),
    }
    const injector = {
        get: () => ({ openNewTab: params => {
            const destroyed = new Subject<void>()
            const output = new Subject<Buffer>()
            const session = { open: ready, resize: () => undefined, destroy: async () => { session.open = false } }
            const tab = {
                profile: params.inputs.profile, session, binaryOutput$: output, sessionChanged$: new Subject(), destroyed$: destroyed,
                sendInput: () => undefined,
                destroy: async () => { destroyed.next(); destroyed.complete(); output.complete(); await session.destroy() },
            }
            opened.push(tab)
            return tab
        } }),
    }
    const adapter = new Service(config as any, profiles as any, injector as any)
    return { adapter, opened, saved: () => saved, config }
}

test('terminal adapter creates an independent profile and disposes only its own tab', async () => {
    const profile = { id: 'local', type: 'local', name: 'Shell', options: { restoreFromPTYID: 'existing-user-pty' }, behaviorOnSessionEnd: 'reconnect' }
    const fixture = adapterFixture(profile)
    const result: any = await fixture.adapter.callOperation('token', profile, 'open_connection', {}, async () => true)
    assert.ok(result.sessionId)
    assert.equal(fixture.opened.length, 1)
    assert.equal(fixture.opened[0].profile.options.restoreFromPTYID, null)
    assert.equal(fixture.opened[0].profile.options.reuseSession, false)
    assert.equal(fixture.opened[0].profile.behaviorOnSessionEnd, 'close')
    assert.deepEqual(fixture.saved(), profile)
    await fixture.adapter.disposeAll()
    assert.equal(fixture.opened[0].session.open, false)
})

test('a pending PTY that finishes opening after cancellation is immediately destroyed', async () => {
    const profile = { id: 'local', type: 'local', name: 'Shell', options: {} }
    const fixture = adapterFixture(profile, false)
    let allowed = true
    const opening = fixture.adapter.callOperation('token', profile, 'open_connection', {}, async () => allowed)
    while (!fixture.opened.length) { await new Promise<void>(resolve => setImmediate(resolve)) }
    allowed = false
    await fixture.adapter.disposeToken('token')
    await assert.rejects(opening, /denied/)
    fixture.opened[0].session.open = true
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(fixture.opened[0].session.open, false)
})

test('local file transfer uses MCP payload bytes without requiring a terminal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-mcp-test-'))
    const target = path.join(directory, 'target.bin')
    const oversized = path.join(directory, 'large.bin')
    const profile = { id: 'local', type: 'local', name: 'Shell', options: { cwd: directory } }
    const fixture = adapterFixture(profile)
    try {
        const data = Buffer.from([0, 1, 2, 255])
        assert.deepEqual(await fixture.adapter.callOperation('token', profile, 'upload_file', { path: 'target.bin', data: data.toString('base64') }, async () => true), { bytes: 4 })
        assert.deepEqual(await fs.readFile(target), data)
        assert.deepEqual(await fixture.adapter.callOperation('token', profile, 'download_file', { path: 'target.bin' }, async () => true), { data: data.toString('base64'), encoding: 'base64', bytes: 4 })
        assert.equal(fixture.opened.length, 0)
        await fs.writeFile(oversized, '')
        await fs.truncate(oversized, MCP_MAX_FILE_BYTES + 1)
        await assert.rejects(fixture.adapter.callOperation('token', profile, 'download_file', { path: 'large.bin' }, async () => true), /4 MiB/)
        assert.deepEqual((await fs.readdir(directory)).sort(), ['large.bin', 'target.bin'])
    } finally {
        await fixture.adapter.disposeAll()
        await Promise.all([target, oversized].map(file => fs.unlink(file).catch(() => undefined)))
        await fs.rmdir(directory)
    }
})

test('unsupported file providers fail explicitly and configuration saves roll back', async () => {
    const profile = { id: 'telnet', type: 'telnet', name: 'Telnet', options: { host: 'localhost', port: 23 } }
    const fixture = adapterFixture(profile)
    await assert.rejects(fixture.adapter.callOperation('token', profile, 'download_file', { path: '/file' }, async () => true), /only for SSH and local/)
    fixture.config.save = async () => { throw new Error('Disk failure') }
    await assert.rejects(fixture.adapter.callOperation('token', profile, 'update_connection_config', { changes: { name: 'New' } }, async () => true), /Disk failure/)
    assert.deepEqual(fixture.saved(), profile)
    await fixture.adapter.disposeAll()
})

test('configuration edits return an acknowledgement without granting configuration read access', async () => {
    const profile = { id: 'ssh', type: 'ssh', name: 'Server', options: { host: 'private-host', password: 'secret' } }
    const fixture = adapterFixture(profile)
    assert.deepEqual(await fixture.adapter.callOperation('token', profile, 'update_connection_config', { changes: { name: 'New' } }, async () => true), { connectionId: 'ssh', updated: true })
    assert.equal(fixture.saved().name, 'New')
    assert.equal(fixture.saved().options.password, 'secret')
    await fixture.adapter.disposeAll()
})

function sftpFixture (chunks: Buffer[] = [], size = 0) {
    const profile = { id: 'ssh', type: 'ssh', name: 'SSH', options: { host: 'server', port: 22, forwardedPorts: [{ port: 1234 }], agentForward: true } }
    let closes = 0
    let disconnects = 0
    let reads = 0
    let flags = 0
    const written: Buffer[] = []
    const openedProfiles: any[] = []
    const hooks = { start: async () => undefined, read: async () => undefined, open: async () => undefined }
    const handle = {
        read: async () => { reads++; await hooks.read(); return chunks.shift() ?? Buffer.alloc(0) },
        write: async (data: Uint8Array) => { written.push(Buffer.from(data)) },
        close: async () => { closes++ },
    }
    const sftp = {
        stat: async () => ({ isDirectory: false, size }),
        open: async (_target: string, mode: number) => { flags = mode; await hooks.open(); return handle },
    }
    class MockSSHConnectionsService extends MCPConnectionsService {
        protected createSSHSession (target: any): any {
            openedProfiles.push(target)
            return {
                keyboardInteractivePrompt$: new Subject(),
                start: async () => hooks.start(),
                destroy: async () => { disconnects++ },
                openSFTP: async () => sftp,
            }
        }
        protected getSFTPFlags () { return { OPEN_READ: 1, OPEN_WRITE: 2, OPEN_CREATE: 8, OPEN_TRUNCATE: 16 } }
    }
    const fixture = adapterFixture(profile, true, MockSSHConnectionsService)
    return { ...fixture, profile, hooks, written, openedProfiles, closes: () => closes, disconnects: () => disconnects, reads: () => reads, flags: () => flags }
}

test('SSH uploads include empty files, disable forwarding and close native resources', async () => {
    const fixture = sftpFixture()
    assert.deepEqual(await fixture.adapter.callOperation('token', fixture.profile, 'upload_file', { path: '/empty', data: '' }, async () => true), { bytes: 0 })
    assert.deepEqual(fixture.written, [Buffer.alloc(0)])
    assert.equal(fixture.flags(), 2 | 8 | 16)
    assert.equal(fixture.closes(), 1)
    assert.equal(fixture.disconnects(), 1)
    assert.deepEqual(fixture.openedProfiles[0].options.forwardedPorts, [])
    assert.equal(fixture.openedProfiles[0].options.agentForward, false)
    assert.equal(fixture.opened.length, 0)
    await fixture.adapter.disposeAll()
})

test('SSH downloads combine chunks, reject growth beyond stat and always close handles', async () => {
    const fixture = sftpFixture([Buffer.from('first'), Buffer.from('second')], 11)
    const result: any = await fixture.adapter.callOperation('token', fixture.profile, 'download_file', { path: '/file' }, async () => true)
    assert.equal(Buffer.from(result.data, 'base64').toString(), 'firstsecond')
    assert.equal(fixture.closes(), 1)
    assert.equal(fixture.disconnects(), 1)
    await fixture.adapter.disposeAll()
    const growing = sftpFixture([Buffer.alloc(MCP_MAX_FILE_BYTES), Buffer.from([1])], 1)
    await assert.rejects(growing.adapter.callOperation('token', growing.profile, 'download_file', { path: '/growing' }, async () => true), /4 MiB/)
    assert.equal(growing.closes(), 1)
    assert.equal(growing.disconnects(), 1)
    await growing.adapter.disposeAll()
})

test('revoking during SSH authentication cleans the client again when authentication finishes late', async () => {
    const fixture = sftpFixture()
    let release: () => void
    let started: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { started = resolve })
    fixture.hooks.start = async () => { started(); await gate }
    const downloading = fixture.adapter.callOperation('token', fixture.profile, 'download_file', { path: '/file' }, async () => true)
    await ready
    await fixture.adapter.disposeToken('token')
    release!()
    await assert.rejects(downloading, /denied/)
    assert.ok(fixture.disconnects() >= 2)
    assert.equal(fixture.closes(), 0)
})

test('a native SFTP handle returned after cancellation is closed without reading it', async () => {
    const fixture = sftpFixture([Buffer.from('secret')], 6)
    let release: () => void
    let started: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { started = resolve })
    fixture.hooks.open = async () => { started(); await gate }
    const downloading = fixture.adapter.callOperation('token', fixture.profile, 'download_file', { path: '/file' }, async () => true)
    await ready
    await fixture.adapter.disposeToken('token')
    release!()
    await assert.rejects(downloading, /denied/)
    assert.equal(fixture.reads(), 0)
    assert.equal(fixture.closes(), 1)
    assert.equal(fixture.disconnects(), 1)
})
