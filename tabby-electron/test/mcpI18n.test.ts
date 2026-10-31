import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import pug from 'pug'
import gettext from 'gettext-parser'
import { GettextExtractor, HtmlExtractors, JsExtractors } from 'gettext-extractor'

test('MCP settings and modal have English and Chinese translations with matching parameters', () => {
    const extractor = new GettextExtractor()
    for (const name of ['mcpSettingsTab', 'mcpTokenModal']) {
        const file = fileURLToPath(new URL(`../src/components/${name}.component.pug`, import.meta.url))
        extractor.createHtmlParser([
            HtmlExtractors.elementContent('translate, [translate=""]'),
            HtmlExtractors.elementAttribute('[translate*=" "]', 'translate'),
        ]).parseString(pug.renderFile(file, { doctype: 'html' }), file)
        const source = file.replace(/\.pug$/, '.ts')
        extractor.createJsParser([JsExtractors.callExpression('_', { arguments: { text: 0 } })])
            .parseString(readFileSync(source, 'utf8'), source)
    }
    const vaultSource = fileURLToPath(new URL('../../tabby-core/src/services/vault.service.ts', import.meta.url))
    extractor.createJsParser([JsExtractors.callExpression('_', { arguments: { text: 0 } })])
        .parseString(readFileSync(vaultSource, 'utf8'), vaultSource)
    for (const locale of ['en-US', 'zh-CN']) {
        const catalog = gettext.po.parse(readFileSync(new URL(`../../locale/${locale}.po`, import.meta.url))).translations['']
        for (const { text } of extractor.getMessages()) {
            const translated = catalog[text]?.msgstr[0]
            assert.ok(translated, `${locale} is missing: ${text}`)
            const parameters = (value: string) => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort()
            assert.deepEqual(parameters(translated), parameters(text), `${locale}: ${text}`)
        }
    }
})
