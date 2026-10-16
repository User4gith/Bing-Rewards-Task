import type { Page } from 'patchright'

export function validRewardsContent(text: string, contentType: string, kind: 'html' | 'javascript'): boolean {
    if (!text.trim()) return false
    if (kind === 'javascript') {
        if (/html|json/i.test(contentType) || /^\s*(?:<!doctype|<html|<head|<body)/i.test(text)) return false
        return !contentType || /javascript|ecmascript|octet-stream|text\/plain/i.test(contentType)
    }
    return !contentType || /html|x-component/i.test(contentType)
}

export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Rewards request deadline exceeded')), timeoutMs)
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/** Both the fetch/body read and the evaluate transport have deadlines. */
export async function fetchRewardsInBrowser(
    page: Page,
    url: string,
    kind: 'html' | 'javascript',
    timeoutMs = 15_000
): Promise<string | null> {
    const result = await withDeadline(
        page.evaluate(
            async ({ url, timeoutMs }) => {
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), timeoutMs)
                try {
                    const response = await fetch(url, {
                        credentials: 'same-origin',
                        cache: 'no-store',
                        signal: controller.signal
                    })
                    if (!response.ok || new URL(response.url || url).origin !== new URL(url).origin) return null
                    return { text: await response.text(), contentType: response.headers.get('content-type') ?? '' }
                } catch {
                    return null
                } finally {
                    clearTimeout(timer)
                }
            },
            { url, timeoutMs }
        ),
        timeoutMs + 1000
    )
    return result && validRewardsContent(result.text, result.contentType, kind) ? result.text : null
}
