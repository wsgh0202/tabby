import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentConnectionSpec, SshPublicKey } from 'russh'
import { getAgentAuthMethods } from '../src/session/agentAuth.ts'
import type { AgentAuthDependencies } from '../src/session/agentAuth.ts'
import type { AgentIdentity } from '../src/session/agentIdentities.ts'

const spec: AgentConnectionSpec = { kind: 'unix-socket', path: '/tmp/ssh-agent.sock' }
const defaults = { host: 'example.com', user: 'alice', privateKeys: [] as string[] }

function createDependencies (identities: AgentIdentity[] = []) {
    const parsedKeys = new Map<string, SshPublicKey>()
    const filesRead: string[] = []
    const messages: string[] = []
    let identityRequests = 0
    const dependencies: AgentAuthDependencies = {
        parsePublicKey: contents => {
            if (contents === 'invalid') {
                throw new Error('Invalid public key')
            }
            const key = {} as SshPublicKey
            parsedKeys.set(contents, key)
            return key
        },
        getIdentities: async () => {
            identityRequests++
            return identities
        },
        readFile: async path => {
            filesRead.push(path)
            return Buffer.from(path)
        },
        emitMessage: message => messages.push(message),
    }
    return { dependencies, parsedKeys, filesRead, messages, get identityRequests () { return identityRequests } }
}

describe('SSH agent identity selection', () => {
    it('selects a named key after many unrelated identities without an unrestricted fallback', async () => {
        const identities = Array.from({ length: 20 }, (_, index) => ({ publicKey: `key-${index}`, comment: `other-${index}` }))
        identities.push({ publicKey: 'target-key', comment: 'production' })
        const fixture = createDependencies(identities)

        const methods = await getAgentAuthMethods({ ...defaults, agentKeyName: 'production' }, spec, fixture.dependencies)

        assert.deepEqual(methods, [{ type: 'agent', ...spec, publicKey: fixture.parsedKeys.get('target-key') }])
        assert.deepEqual([...fixture.parsedKeys.keys()], ['target-key'])
        assert.equal(fixture.identityRequests, 1)
        assert.deepEqual(fixture.filesRead, [])
    })

    it('uses pasted public key text before a name or configured key files', async () => {
        const fixture = createDependencies([{ publicKey: 'named-key', comment: 'production' }])

        const methods = await getAgentAuthMethods({
            ...defaults,
            privateKeys: ['id_ed25519'],
            agentKeyName: 'production',
            agentPublicKey: '  ssh-ed25519 pasted-key comment\n',
        }, spec, fixture.dependencies)

        assert.deepEqual(methods, [{ type: 'agent', ...spec, publicKey: fixture.parsedKeys.get('ssh-ed25519 pasted-key comment') }])
        assert.equal(fixture.identityRequests, 0)
        assert.deepEqual(fixture.filesRead, [])
    })

    it('does not fall back to a name or all keys when pasted public key text is invalid', async () => {
        const fixture = createDependencies([{ publicKey: 'named-key', comment: 'production' }])

        const methods = await getAgentAuthMethods({ ...defaults, agentPublicKey: 'invalid', agentKeyName: 'production' }, spec, fixture.dependencies)

        assert.deepEqual(methods, [])
        assert.equal(fixture.identityRequests, 0)
        assert.match(fixture.messages[0], /Could not parse.*public key/)
    })

    it('matches names exactly and does not try unrelated keys when no name matches', async () => {
        const fixture = createDependencies([
            { publicKey: 'one', comment: 'production-backup' },
            { publicKey: 'two', comment: 'Production' },
        ])

        const methods = await getAgentAuthMethods({ ...defaults, agentKeyName: 'production' }, spec, fixture.dependencies)

        assert.deepEqual(methods, [])
        assert.equal(fixture.parsedKeys.size, 0)
        assert.match(fixture.messages[0], /No SSH agent keys match.*production/)
    })

    it('tries only matching identities in agent order when names are duplicated', async () => {
        const fixture = createDependencies([
            { publicKey: 'first', comment: 'production' },
            { publicKey: 'unrelated', comment: 'development' },
            { publicKey: 'second', comment: 'production' },
        ])

        const methods = await getAgentAuthMethods({ ...defaults, agentKeyName: 'production' }, spec, fixture.dependencies)

        assert.deepEqual(methods.map(method => method.publicKey), [fixture.parsedKeys.get('first'), fixture.parsedKeys.get('second')])
        assert.equal(methods.every(method => method.publicKey !== undefined), true)
    })

    it('uses the trimmed name when public key text is blank', async () => {
        const fixture = createDependencies([{ publicKey: 'named-key', comment: 'production' }])

        const methods = await getAgentAuthMethods({ ...defaults, agentKeyName: ' production\n', agentPublicKey: ' \t\n' }, spec, fixture.dependencies)

        assert.deepEqual(methods, [{ type: 'agent', ...spec, publicKey: fixture.parsedKeys.get('named-key') }])
    })

    it('reports agent listing failures without enabling unrestricted authentication', async () => {
        const fixture = createDependencies()
        fixture.dependencies.getIdentities = async () => { throw new Error('Agent disconnected') }

        const methods = await getAgentAuthMethods({ ...defaults, agentKeyName: 'production' }, spec, fixture.dependencies)

        assert.deepEqual(methods, [])
        assert.match(fixture.messages[0], /Could not find SSH agent keys by name.*Agent disconnected/)
    })

    it('retains unrestricted authentication for existing profiles on each agent backend', async () => {
        const specs: AgentConnectionSpec[] = [spec, { kind: 'named-pipe', path: '\\\\.\\pipe\\openssh-ssh-agent' }, { kind: 'pageant' }]
        for (const connection of specs) {
            const fixture = createDependencies()

            assert.deepEqual(await getAgentAuthMethods(defaults, connection, fixture.dependencies), [{ type: 'agent', ...connection }])
            assert.equal(fixture.identityRequests, 0)
        }
    })

    it('preserves public-key-file priority and fallback when both selectors are blank', async () => {
        const fixture = createDependencies()

        const methods = await getAgentAuthMethods({
            ...defaults,
            privateKeys: ['/keys/%h/%r', '/keys/second.pub'],
            agentKeyName: ' \t',
            agentPublicKey: '\n',
        }, spec, fixture.dependencies)

        assert.deepEqual(fixture.filesRead, ['/keys/example.com/alice.pub', '/keys/second.pub'])
        assert.deepEqual(methods, [
            { type: 'agent', ...spec, publicKey: fixture.parsedKeys.get('/keys/example.com/alice.pub') },
            { type: 'agent', ...spec, publicKey: fixture.parsedKeys.get('/keys/second.pub') },
            { type: 'agent', ...spec },
        ])
        assert.equal(fixture.identityRequests, 0)
    })

    it('skips unreadable public-key files and retains the existing fallback', async () => {
        const fixture = createDependencies()
        fixture.dependencies.readFile = async () => { throw new Error('File not found') }

        const methods = await getAgentAuthMethods({ ...defaults, privateKeys: ['/keys/missing'] }, spec, fixture.dependencies)

        assert.deepEqual(methods, [{ type: 'agent', ...spec }])
        assert.match(fixture.messages[0], /Could not load.*missing.pub.*File not found/)
    })

    it('skips invalid public-key files and retains the existing fallback', async () => {
        const fixture = createDependencies()
        fixture.dependencies.readFile = async () => Buffer.from('invalid')

        const methods = await getAgentAuthMethods({ ...defaults, privateKeys: ['/keys/invalid'] }, spec, fixture.dependencies)

        assert.deepEqual(methods, [{ type: 'agent', ...spec }])
        assert.match(fixture.messages[0], /Could not load.*invalid.pub.*Invalid public key/)
    })
})
