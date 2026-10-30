export interface AgentIdentity {
    publicKey: string
    comment: string
}

interface AgentIdentityObserver {
    next: (data: Uint8Array) => void
    error: (error: unknown) => void
    complete: () => void
}

export interface AgentIdentityStream {
    data$: {
        subscribe: (observer: AgentIdentityObserver) => { unsubscribe: () => void }
    }
    write: (data: Uint8Array) => Promise<void>
}

const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENT_IDENTITIES_ANSWER = 12
const MAX_AGENT_RESPONSE_LENGTH = 1024 * 1024

function parseAgentIdentities (payload: Buffer): AgentIdentity[] {
    if (payload[0] !== SSH_AGENT_IDENTITIES_ANSWER) {
        throw new Error('SSH agent refused to list identities')
    }

    let offset = 1
    const readUint32 = (): number => {
        if (payload.length - offset < 4) {
            throw new Error('Truncated SSH agent identities response')
        }
        const value = payload.readUInt32BE(offset)
        offset += 4
        return value
    }
    const readString = (): Buffer => {
        const length = readUint32()
        if (length > payload.length - offset) {
            throw new Error('Truncated SSH agent identity')
        }
        const value = payload.subarray(offset, offset + length)
        offset += length
        return value
    }

    const count = readUint32()
    const identities: AgentIdentity[] = []
    for (let index = 0; index < count; index++) {
        const keyBlob = readString()
        const comment = readString().toString('utf8')
        if (keyBlob.length < 4) {
            throw new Error('Invalid SSH agent public key')
        }
        const algorithmLength = keyBlob.readUInt32BE(0)
        if (!algorithmLength || algorithmLength > keyBlob.length - 4) {
            throw new Error('Invalid SSH agent public key algorithm')
        }
        const algorithm = keyBlob.subarray(4, 4 + algorithmLength).toString('utf8')
        identities.push({
            publicKey: `${algorithm} ${keyBlob.toString('base64')}`,
            comment,
        })
    }
    if (offset !== payload.length) {
        throw new Error('Unexpected data in SSH agent identities response')
    }
    return identities
}

/** List public keys and their agent-provided names without attempting server authentication. */
export function requestAgentIdentities (stream: AgentIdentityStream, timeoutMs = 10000): Promise<AgentIdentity[]> {
    return new Promise((resolve, reject) => {
        let data = Buffer.alloc(0)
        const state = { finished: false }
        let subscription: { unsubscribe: () => void }|null = null
        let timeout: ReturnType<typeof setTimeout>|null = null

        const finish = (result: AgentIdentity[]|Error) => {
            if (state.finished) {
                return
            }
            state.finished = true
            if (timeout) {
                clearTimeout(timeout)
            }
            subscription?.unsubscribe()
            if (result instanceof Error) {
                reject(result)
            } else {
                resolve(result)
            }
        }
        const fail = (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)))
        timeout = setTimeout(() => finish(new Error('Timed out waiting for SSH agent identities')), timeoutMs)

        try {
            // Subscribe before writing: an agent may return its response immediately.
            subscription = stream.data$.subscribe({
                next: chunk => {
                    if (state.finished) {
                        return
                    }
                    try {
                        if (data.length + chunk.length > MAX_AGENT_RESPONSE_LENGTH + 4) {
                            throw new Error('SSH agent identities response is too large')
                        }
                        data = Buffer.concat([data, chunk])
                        if (data.length < 4) {
                            return
                        }
                        const length = data.readUInt32BE(0)
                        if (!length || length > MAX_AGENT_RESPONSE_LENGTH) {
                            throw new Error('Invalid SSH agent identities response length')
                        }
                        if (data.length < length + 4) {
                            return
                        }
                        if (data.length !== length + 4) {
                            throw new Error('Unexpected data after SSH agent identities response')
                        }
                        finish(parseAgentIdentities(data.subarray(4)))
                    } catch (error) {
                        fail(error)
                    }
                },
                error: fail,
                complete: () => finish(new Error('SSH agent closed before listing identities')),
            })

            // A stream may already be closed when subscribe() returns.
            if (state.finished) {
                subscription.unsubscribe()
            } else {
                stream.write(Buffer.from([0, 0, 0, 1, SSH_AGENTC_REQUEST_IDENTITIES])).catch(fail)
            }
        } catch (error) {
            fail(error)
        }
    })
}
