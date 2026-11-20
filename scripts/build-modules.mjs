#!/usr/bin/env node
import * as vars from './vars.mjs'
import log from 'npmlog'
import webpack from 'webpack'
import { promisify } from 'node:util'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const configs = [
    '../app/webpack.config.main.mjs',
    '../app/webpack.config.mjs',
    ...vars.allPackages.map(x => `../${x}/webpack.config.mjs`),
];

(async () => {
    try {
        if (process.platform === 'win32') {
            const native = new URL('../app/native/windows-hello/', import.meta.url)
            const dist = new URL('../app/dist/', import.meta.url)
            const nodeGyp = new URL('../node_modules/node-gyp/bin/node-gyp.js', import.meta.url)
            execFileSync(process.execPath, [
                fileURLToPath(nodeGyp), 'rebuild',
                `--target=${vars.electronVersion}`,
                `--arch=${process.env.ARCH || process.arch}`,
                '--dist-url=https://electronjs.org/headers',
            ], { cwd: native, stdio: 'inherit' })
            mkdirSync(dist, { recursive: true })
            copyFileSync(new URL('build/Release/windows-hello.node', native), new URL('windows-hello.node', dist))
        }
        for (const c of configs) {
            log.info('build', c)
            const stats = await promisify(webpack)((await import(c)).default())
            console.log(stats.toString({ colors: true }))
            if (stats.hasErrors()) {
                process.exit(1)
            }
        }
    } catch (error) {
        log.error('build', String(error))
        process.exit(1)
    }
})()
