import type { ParsedOffer, PageSnapshot } from '../../../browser/ReactFunc'
import type { BasePromotion, Dashboard, DashboardData } from '../../../interface/DashboardData'

export type TaskCategory = 'dailySet' | 'dailyActivities' | 'moreActivities' | 'punchCards' | 'other'

export interface DiscoveredTask {
    promotion: BasePromotion
    category: TaskCategory
    sources: string[]
    date: string | null
    parentId?: string
}

export function normaliseTaskDate(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
    if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/** Use the browser/account clock, rather than the host's timezone. */
export function taskDate(offset: string | number = new Date().getTimezoneOffset(), now = Date.now()): string {
    const parsed = Number(offset)
    const date = new Date(now - (Number.isFinite(parsed) ? parsed : 0) * 60_000)
    return date.toISOString().slice(0, 10)
}

export function promotionComplete(promotion: Partial<BasePromotion>): boolean {
    return (
        promotion.complete === true ||
        (Number(promotion.pointProgressMax) > 0 &&
            Number(promotion.pointProgress) >= Number(promotion.pointProgressMax))
    )
}

export function isLockedPromotion(promotion: Partial<BasePromotion>): boolean {
    const raw = promotion as Record<string, unknown>
    return raw.isLocked === true || raw.isDisabled === true || promotion.exclusiveLockedFeatureStatus === 'locked'
}

export function isQuestId(offerId: string): boolean {
    return /pcparent|pcchild|punchcard/i.test(offerId)
}

export function parsedOfferPromotion(offer: ParsedOffer): BasePromotion {
    return {
        offerId: offer.offerId,
        title: offer.title,
        name: offer.offerId,
        description: offer.description,
        hash: offer.hash ?? '',
        complete: offer.isCompleted,
        pointProgress: offer.isCompleted ? offer.points : 0,
        pointProgressMax: offer.points,
        activityProgress: offer.isCompleted ? 1 : 0,
        activityProgressMax: 1,
        promotionType: offer.promotionType ?? '',
        promotionSubtype: offer.promotionSubtype ?? '',
        destinationUrl: offer.destination,
        activityType: offer.activityType ? String(offer.activityType) : '',
        priority: 0,
        attributes: { promotional: offer.isPromotional },
        isLocked: offer.isLocked,
        date: offer.date
    } as unknown as BasePromotion
}

/** Walk every activity/promotion pool, including new pool names and nested card children.
 * Catalog/redemption/profile objects are deliberately outside the earning inventory. */
export function collectPromotions(dashboard: Dashboard | Record<string, unknown>): DiscoveredTask[] {
    const tasks = new Map<string, DiscoveredTask>()
    const ignored =
        /^(userStatus|userProfile|profile|suggestedRewards|autoRedeem.*|catalog|badges|coupons|coupon.*|userInterests|dashboardFlights)$/i
    const visited = new Set<object>()

    const walk = (
        value: unknown,
        source: string,
        category: TaskCategory,
        date: string | null,
        parentId?: string
    ): void => {
        if (!value || typeof value !== 'object' || visited.has(value)) return
        visited.add(value)
        if (Array.isArray(value)) {
            value.forEach(item => walk(item, source, category, date, parentId))
            return
        }
        const record = value as Record<string, unknown>
        const id = typeof record.offerId === 'string' ? record.offerId : null
        const wrapperParent =
            record.parentPromotion && typeof record.parentPromotion === 'object'
                ? (record.parentPromotion as Record<string, unknown>).offerId
                : undefined
        const earning =
            Number(record.pointProgressMax) > 0 ||
            (typeof record.hash === 'string' && record.hash !== '$undefined' && !!record.hash) ||
            category === 'punchCards' ||
            /^(urlreward|quiz|poll|trivia|search)$/i.test(String(record.promotionType ?? ''))
        if (id && earning) {
            const promotion = record as unknown as BasePromotion
            const candidate = {
                promotion,
                category,
                sources: [source],
                date: normaliseTaskDate(record.date) ?? date,
                parentId
            }
            const existing = tasks.get(id)
            if (existing) {
                existing.sources.push(source)
                // Keep complete/progress evidence while filling fields absent in one representation.
                const merged = { ...existing.promotion }
                for (const [key, item] of Object.entries(record)) {
                    if (item !== undefined && item !== null && item !== '')
                        (merged as unknown as Record<string, unknown>)[key] = item
                }
                merged.complete = promotionComplete(existing.promotion) || promotionComplete(promotion)
                merged.pointProgressMax = Math.max(
                    Number(existing.promotion.pointProgressMax) || 0,
                    Number(promotion.pointProgressMax) || 0
                )
                merged.pointProgress = Math.max(
                    Number(existing.promotion.pointProgress) || 0,
                    Number(promotion.pointProgress) || 0
                )
                existing.promotion = merged
                if (category === 'dailySet' || category === 'punchCards') existing.category = category
                existing.parentId ??= parentId
                existing.date ??= candidate.date
            } else tasks.set(id, candidate)
        }
        for (const [key, item] of Object.entries(record)) {
            if (ignored.test(key) || key === 'attributes') continue
            const nextCategory: TaskCategory = /punch|quest|childPromotions|parentPromotion/i.test(key)
                ? 'punchCards'
                : /daily.?set/i.test(key)
                  ? 'dailySet'
                  : /daily.?activit/i.test(key)
                    ? 'dailyActivities'
                    : /more.?activit|more.?promotion/i.test(key)
                      ? 'moreActivities'
                      : category
            const nextDate = normaliseTaskDate(key) ?? date
            walk(
                item,
                `${source}.${key}`,
                nextCategory,
                nextDate,
                /child/i.test(key) ? (id ?? (typeof wrapperParent === 'string' ? wrapperParent : parentId)) : parentId
            )
        }
    }
    walk(dashboard, 'dashboard', 'other', null)
    return [...tasks.values()].map(task => ({ ...task, sources: [...new Set(task.sources)] }))
}

export function discoverTasks(data: DashboardData, snapshot?: PageSnapshot | null): DiscoveredTask[] {
    const tasks = collectPromotions(data.dashboard)
    const seen = new Set(tasks.map(task => task.promotion.offerId))
    for (const offer of snapshot?.offers ?? []) {
        if (seen.has(offer.offerId)) continue
        if (
            offer.points <= 0 &&
            !offer.hash &&
            !isQuestId(offer.offerId) &&
            !/^(urlreward|quiz|poll|trivia|search)$/i.test(offer.promotionType ?? '')
        )
            continue
        seen.add(offer.offerId)
        tasks.push({
            promotion: parsedOfferPromotion(offer),
            category: isQuestId(offer.offerId)
                ? 'punchCards'
                : /daily.?set/i.test(offer.offerId)
                  ? 'dailySet'
                  : 'other',
            sources: ['page'],
            date: offer.date
        })
    }
    return tasks
}

export function findPromotion(dashboard: Dashboard, offerId: string): BasePromotion | undefined {
    return collectPromotions(dashboard).find(task => task.promotion.offerId === offerId)?.promotion
}

export function isSearchCard(promotion: BasePromotion): boolean {
    return /exploreonbing|searchonbing|searchactivity/i.test(`${promotion.name ?? ''} ${promotion.offerId}`)
}

export function isBareSearchCard(promotion: BasePromotion): boolean {
    try {
        const url = new URL(promotion.destinationUrl)
        return (
            /(^|\.)bing\.com$/i.test(url.hostname) &&
            /^\/?$/.test(url.pathname) &&
            [...url.searchParams.keys()].every(key => /^(form|ocid|publ|crea|pc|channel|mkt|cc|setlang)$/i.test(key))
        )
    } catch {
        return false
    }
}

export function isBonusSearchCard(promotion: BasePromotion): boolean {
    return (
        !isSearchCard(promotion) &&
        isBareSearchCard(promotion) &&
        Number(promotion.pointProgressMax) > 0 &&
        !/visual.?search|optin[_-]?\d+x|search.?multiplier/i.test(promotion.offerId) &&
        !(promotion.attributes as Record<string, unknown> | null)?.searchMultiplier
    )
}
