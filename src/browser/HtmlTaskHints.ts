import { createHash } from 'node:crypto'
import type { ParsedOffer } from './ReactFunc'

function decode(value: string): string {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
}

export function canonicalTaskUrl(value: string): string {
    try {
        const url = new URL(decode(value), 'https://rewards.bing.com')
        for (const key of [...url.searchParams.keys()])
            if (/^(form|ocid|cvid|pc|mkt|cc|setlang)$/i.test(key)) url.searchParams.delete(key)
        url.searchParams.sort()
        url.hash = ''
        return url.href
    } catch {
        return value
    }
}

/** Hints keep visible scored cards in the audit when their JSON metadata is missing.
 * Absence of a card is never completion; only explicit server-rendered completion is used. */
export function htmlTaskHints(html: string): ParsedOffer[] {
    const result: ParsedOffer[] = []
    const attr = (text: string, name: string): string | null => {
        const match = text.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
        return match ? decode(match[1]!) : null
    }
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const attributes = match[1]!,
            content = match[2]!
        const destination = attr(attributes, 'href')
        if (!destination || !/^https?:|^\//i.test(destination)) continue
        const title = decode(
            content
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        )
        const label = attr(attributes, 'aria-label') ?? title
        const cue =
            /data-(?:points|offer-id|offerid)\s*=/i.test(attributes) ||
            /[?&](?:amp;)?offerid=/i.test(destination) ||
            /\+\s*\d+/.test(label) ||
            /card|activity|dailyset|promotion/i.test(attributes)
        if (!cue) continue
        const pointsText =
            attr(attributes, 'data-points') ??
            /(?:\+\s*)?(\d+)\s*(?:points?|积分|分)\b/i.exec(label)?.[1] ??
            /(?:\+\s*)?(\d+)\s*(?:积分|分)(?:\s|$)/.exec(label)?.[1]
        const points = Number(pointsText)
        if (!Number.isFinite(points) || points <= 0) continue
        let offerId = attr(attributes, 'data-offer-id') ?? attr(attributes, 'data-offerid')
        try {
            const url = new URL(destination, 'https://rewards.bing.com')
            offerId ??= url.searchParams.get('offerid') ?? url.searchParams.get('offerId')
        } catch {}
        offerId ||= `page-link:${createHash('sha256').update(canonicalTaskUrl(destination)).digest('hex').slice(0, 20)}`
        const isCompleted = attr(attributes, 'data-complete') === 'true'
        const isLocked = attr(attributes, 'aria-disabled') === 'true'
        result.push({
            offerId,
            title: title || label,
            description: '',
            points,
            destination,
            hash: null,
            promotionType: '',
            promotionSubtype: 'html-card',
            activityType: null,
            isCompleted,
            isLocked,
            isPromotional: false,
            unlockCriteria: null,
            date: null,
            reportable: false
        })
    }
    return result
}
