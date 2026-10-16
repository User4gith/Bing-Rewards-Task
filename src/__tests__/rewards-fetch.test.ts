import test from 'node:test'
import assert from 'node:assert/strict'
import type { Page } from 'patchright'
import { fetchRewardsInBrowser, validRewardsContent, withDeadline } from '../browser/RewardsFetch'

test('HTML error pages cannot be accepted as JavaScript on either request path', () => {
    assert.equal(validRewardsContent('<html>Proxy error</html>', 'text/html', 'javascript'), false)
    assert.equal(validRewardsContent('<!DOCTYPE html><html>Error</html>', '', 'javascript'), false)
    assert.equal(validRewardsContent('{"error":"denied"}', 'application/json', 'javascript'), false)
    assert.equal(validRewardsContent('self.webpackChunk=[];', 'application/javascript', 'javascript'), true)
})

test('evaluate transport deadline covers an operation that never starts or resolves', async () => {
    await assert.rejects(withDeadline(new Promise(() => {}), 10), /deadline/)
})

test('browser fetch abort covers body reads and clears its timer', async () => {
    const originalFetch = globalThis.fetch
    const page = {
        evaluate: async (fn: (args: unknown) => unknown, args: unknown) => await fn(args)
    } as unknown as Page
    let aborted = false
    globalThis.fetch = (async (_url, init) =>
        await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                aborted = true
                reject(new Error('aborted'))
            })
        })) as typeof fetch
    try {
        assert.equal(await fetchRewardsInBrowser(page, 'https://rewards.bing.com/example', 'html', 10), null)
        assert.equal(aborted, true)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('native fallback rejects successful HTML responses for JS requests', async () => {
    const page = { evaluate: async () => ({ text: '<html>error</html>', contentType: 'text/html' }) } as unknown as Page
    assert.equal(await fetchRewardsInBrowser(page, 'https://rewards.bing.com/chunk.js', 'javascript'), null)
})
