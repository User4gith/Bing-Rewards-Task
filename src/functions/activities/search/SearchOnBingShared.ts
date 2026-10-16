import * as fs from 'fs'
import path from 'path'

import { URLs } from '../../../constants/urls'
import type { BasePromotion, Dashboard } from '../../../interface/DashboardData'
import type { MicrosoftRewardsBot } from '../../../index'
import { findPromotion } from '../rewards/TaskDiscovery'

interface ActivityQueries {
    title: string
    aliases?: string[]
    queries: string[]
}

export async function activateSearchOnBing(bot: MicrosoftRewardsBot, promotion: BasePromotion): Promise<boolean> {
    const offerId = promotion.offerId
    const actionId = bot.nextActions.reportActivity

    if (!actionId) {
        bot.logger.warn(bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `跳过 ${offerId}: 未在 bundle 中发现 "reportActivity"`)
        return false
    }

    const live = await bot.browser.func.ensureOffer(offerId)
    const hash = live?.hash ?? promotion.hash ?? null
    if (!hash) {
        bot.logger.warn(bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `跳过 ${offerId}: 激活活动无可用 hash`)
        return false
    }

    try {
        const { status, acknowledged } = await bot.browser.func.reportServerAction(actionId, [
            hash,
            11,
            {
                offerid: offerId,
                isPromotional: '$undefined',
                timezoneOffset: bot.userData.timezoneOffset
            }
        ])

        bot.logger.info(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `活动已激活 | offerId=${offerId} | 状态=${status} | 已确认=${acknowledged}`
        )
        return acknowledged
    } catch (error) {
        bot.logger.error(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `激活失败 | offerId=${offerId} | 错误=${error instanceof Error ? error.message : String(error)}`
        )
        return false
    }
}

export function findSearchOnBingOffer(dashboard: Dashboard, offerId: string): BasePromotion | undefined {
    return findPromotion(dashboard, offerId)
}

export async function getSearchOnBingQueries(bot: MicrosoftRewardsBot, promotion: BasePromotion): Promise<string[]> {
    // Bundled, curated queries must be used even with the default remote-enabled
    // configuration. Remote data supplements titles not yet covered locally.
    try {
        const activities: unknown = JSON.parse(
            fs.readFileSync(path.join(__dirname, '../../bing-search-activity-queries.json'), 'utf8')
        )
        const queries = findQueries(activities, promotion.title)
        if (queries.length) return preparedQueries(bot, promotion.title, queries, '本地增强词库')
    } catch (error) {
        bot.logger.warn(
            bot.isMobile,
            'SEARCH-ON-BING-QUERY',
            `本地主题词库不可用 | 错误=${error instanceof Error ? error.message : String(error)}`
        )
    }

    if (!bot.config.searchOnBingLocalQueries) {
        try {
            const response = await bot.http.request<unknown>({
                method: 'GET',
                url: URLs.github.searchOnBingQueries
            })
            const queries = findQueries(response.data, promotion.title)
            if (queries.length) return preparedQueries(bot, promotion.title, queries, '远程补充词库')
        } catch (error) {
            bot.logger.warn(
                bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `远程主题词库不可用 | 标题="${promotion.title}" | 错误=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    bot.logger.info(bot.isMobile, 'SEARCH-ON-BING-QUERY', `"${promotion.title}" 无精选查询词，回退使用活动标题与描述`)
    return fallbackQueries(promotion)
}

function normalizeTitle(value: string): string {
    // Preserve non-Latin letters: removing them would make unrelated Chinese
    // titles compare equal. Ignore punctuation, spacing and letter case only.
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function findQueries(payload: unknown, title: string): string[] {
    const key = normalizeTitle(title ?? '')
    if (!key || !Array.isArray(payload)) return []
    const queries: string[] = []
    for (const entry of payload) {
        if (!entry || typeof entry !== 'object') continue
        const activity = entry as Partial<ActivityQueries>
        const titles = [activity.title, ...(Array.isArray(activity.aliases) ? activity.aliases : [])]
        if (!titles.some(candidate => typeof candidate === 'string' && normalizeTitle(candidate) === key)) continue
        if (Array.isArray(activity.queries)) {
            queries.push(...activity.queries.filter((query): query is string => typeof query === 'string'))
        }
    }
    const unique = new Map<string, string>()
    for (const query of queries) {
        const clean = query.trim().replace(/\s+/g, ' ')
        if (clean) unique.set(clean.normalize('NFKC').toLowerCase(), clean)
    }
    return [...unique.values()]
}

function preparedQueries(bot: MicrosoftRewardsBot, title: string, queries: string[], source: string): string[] {
    const shuffled = bot.utils.shuffleArray(queries)
    bot.logger.info(
        bot.isMobile,
        'SEARCH-ON-BING-QUERY',
        `为 "${title}" 找到 ${shuffled.length} 条查询词 | 来源=${source}`
    )
    return shuffled
}

function fallbackQueries(promotion: BasePromotion): string[] {
    const title = (promotion.title ?? '').trim()
    const description = (promotion.description ?? '').trim()
    const derived = extractSearchTerm(description)
    return [...new Set([derived, title, description].map(value => value.trim()).filter(Boolean))]
}

// Microsoft currently supplies English instruction prefixes for this fallback path.
function extractSearchTerm(description: string): string {
    if (!description) return ''

    return description
        .trim()
        .replace(
            /^\s*(?:search(?:\s+on\s+bing|\s+bing|\s+the\s+web)?\s+for|look\s+up|find|explore|discover)\b[\s:]+/i,
            ''
        )
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/[.!?]+$/g, '')
        .trim()
}
