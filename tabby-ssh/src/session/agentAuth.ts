import type { AgentConnectionSpec, SshPublicKey } from 'russh'
import type { SSHProfileOptions } from '../api/interfaces'
import type { AgentIdentity } from './agentIdentities'

export type AgentAuthMethod = {
    type: 'agent'
    publicKey?: SshPublicKey
} & AgentConnectionSpec

export interface AgentAuthDependencies {
    parsePublicKey: (contents: string) => SshPublicKey
    getIdentities: () => Promise<AgentIdentity[]>
    readFile: (path: string) => Promise<Buffer>
    emitMessage: (message: string) => void
}

export async function getAgentAuthMethods (
    options: Pick<SSHProfileOptions, 'host'|'user'|'privateKeys'|'agentKeyName'|'agentPublicKey'>,
    spec: AgentConnectionSpec,
    dependencies: AgentAuthDependencies,
): Promise<AgentAuthMethod[]> {
    const publicKeyText = options.agentPublicKey?.trim()
    const keyName = options.agentKeyName?.trim()

    // Explicit selectors restrict agent authentication to the selected identities.
    // Falling back to all agent keys would risk exhausting the server's auth attempts.
    if (publicKeyText) {
        try {
            return [{ type: 'agent', ...spec, publicKey: dependencies.parsePublicKey(publicKeyText) }]
        } catch (error) {
            dependencies.emitMessage(`Could not parse the configured SSH agent public key: ${error}`)
            return []
        }
    }

    if (keyName) {
        try {
            const identities = await dependencies.getIdentities()
            const matches = identities.filter(identity => identity.comment === keyName)
            if (!matches.length) {
                dependencies.emitMessage(`No SSH agent keys match the configured name: ${keyName}`)
            }
            return matches.map(identity => ({
                type: 'agent',
                ...spec,
                publicKey: dependencies.parsePublicKey(identity.publicKey),
            }))
        } catch (error) {
            dependencies.emitMessage(`Could not find SSH agent keys by name: ${error}`)
            return []
        }
    }

    const methods: AgentAuthMethod[] = []
    for (let path of options.privateKeys) {
        path = path.replace('%h', options.host).replace('%r', options.user)
        const publicKeyPath = path.endsWith('.pub') ? path : path + '.pub'
        try {
            const contents = await dependencies.readFile(publicKeyPath)
            methods.push({ type: 'agent', ...spec, publicKey: dependencies.parsePublicKey(contents.toString('utf-8')) })
            dependencies.emitMessage(`Loaded public key for agent auth: ${publicKeyPath}`)
        } catch (error) {
            dependencies.emitMessage(
                `Could not load public key for agent auth from ${publicKeyPath}: ${error}. ` +
                'Agent-identity authentication will not be attempted for this key.',
            )
        }
    }

    // Preserve public-key-file priority and the unrestricted fallback for existing profiles.
    methods.push({ type: 'agent', ...spec })
    return methods
}
