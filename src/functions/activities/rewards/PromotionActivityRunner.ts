import { BaseActivity } from '../BaseActivity'
import type { BasePromotion } from '../../../interface/DashboardData'
import { isBonusSearchCard, isLockedPromotion, isSearchCard, promotionComplete } from './TaskDiscovery'
import { LegacyQuiz } from './LegacyQuiz'
import { ActivateSearchPerk } from '../api/ActivateSearchPerk'
import { BrowserCard, safeCardDestination } from './BrowserCard'

export class PromotionActivityRunner extends BaseActivity {
    public async run(promotions: BasePromotion[]): Promise<void> {
        for (const [index, promotion] of promotions.entries()) {
            try {
                await this.runPromotion(promotion)
                if (index < promotions.length - 1) {
                    await this.bot.utils.wait(this.bot.utils.randomDelay(15000, 60000))
                }
            } catch (error) {
                this.bot.taskCoverage.ledger.set(promotion.offerId, {
                    status: 'failed',
                    reason: error instanceof Error ? error.message : String(error)
                })
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `解决活动 "${promotion.title}" 时出错 | message=${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            }
        }
    }

    private async runPromotion(promotion: BasePromotion): Promise<void> {
        const type = promotion.promotionType?.toLowerCase() ?? ''
        const offerId = promotion.offerId
        const ledger = this.bot.taskCoverage.ledger
        if (promotionComplete(promotion)) {
            ledger.set(offerId, { status: 'complete', reason: '官网任务已完成' })
            return
        }
        if (isLockedPromotion(promotion)) {
            ledger.set(offerId, { status: 'blocked', reason: '官网标记锁定或禁用' })
            return
        }
        ledger.attempt(offerId)

        this.bot.logger.debug(
            this.bot.isMobile,
            'ACTIVITY',
            `处理活动 | 标题="${promotion.title}" | offerId=${offerId} | 类型=${type}`
        )

        const isSearchOnBing = isSearchCard(promotion)
        const isBonusSearch = isBonusSearchCard(promotion)
        const isVisualSearch = /visual.?search/i.test(offerId)
        const isMultiplier =
            /optin[_-]?\d+x|search.?multiplier/i.test(offerId) ||
            !!(promotion.attributes as Record<string, unknown> | null)?.searchMultiplier

        if (isVisualSearch) {
            if (this.bot.isMobile) {
                ledger.set(offerId, { status: 'pending', reason: '等待桌面端执行视觉搜索' })
                return
            }
            const data = await this.bot.browser.func.getDashboardData()
            await this.bot.activities.doVisualSearch(data)
        } else if (isMultiplier) {
            const data = await this.bot.browser.func.getDashboardData()
            await new ActivateSearchPerk(this.bot).activate(data)
        } else if (isBonusSearch) {
            if (!this.bot.config.workers.doBonusSearches) {
                this.logDisabled('BonusSearch', offerId)
                return
            }
            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
            if (!this.bot.config.experimental.apiSearch && (!page || page.isClosed())) {
                ledger.set(offerId, { status: 'pending', reason: '搜索奖励需要可用浏览器会话' })
                return
            }
            await this.bot.activities.doBonusSearches(page)
        } else if (type === 'search') {
            ledger.set(offerId, { status: 'pending', reason: '搜索任务将由搜索配额或多天任务进度核验' })
            return
        } else if (['quiz', 'trivia', 'poll'].includes(type)) {
            await new LegacyQuiz(this.bot).run(promotion)
        } else if (type === 'urlreward' || (!type && !!promotion.hash)) {
            if (isSearchOnBing && !this.bot.config.activities.searchOnBing) {
                this.logDisabled('SearchOnBing', offerId)
                return
            }
            if (!isSearchOnBing && !this.bot.config.activities.urlReward) {
                this.logDisabled('UrlReward', offerId)
                return
            }
            if (isSearchOnBing) {
                const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                if (!this.bot.config.experimental.apiSearchOnBing && (!page || page.isClosed())) {
                    ledger.set(offerId, { status: 'pending', reason: '指定主题搜索需要可用浏览器会话' })
                    return
                }
                await this.bot.activities.doSearchOnBing(promotion, page)
            } else await this.bot.activities.doUrlReward(promotion)
        } else if (!type && safeCardDestination(promotion.destinationUrl)) {
            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
            if (!page || page.isClosed()) {
                ledger.set(offerId, { status: 'pending', reason: '等待浏览器会话访问页面卡片' })
                return
            }
            await new BrowserCard(this.bot).run(promotion)
        } else {
            ledger.set(offerId, {
                status: 'unsupported',
                reason: `未实现的任务类型 ${type || '(缺失类型/元数据)'}，需要人工处理`
            })
            this.bot.logger.warn(
                this.bot.isMobile,
                'ACTIVITY',
                `跳过活动 "${promotion.title}" | offerId=${offerId} | 原因：不支持的类型 "${promotion.promotionType}"`
            )
            return
        }
        const verified = await this.bot.taskCoverage.verify(offerId)
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        if (
            !verified &&
            type === 'urlreward' &&
            safeCardDestination(promotion.destinationUrl) &&
            page &&
            !page.isClosed()
        ) {
            await new BrowserCard(this.bot).run(promotion)
            await this.bot.taskCoverage.verify(offerId)
        }
    }

    private logDisabled(activity: string, offerId: string): void {
        this.bot.taskCoverage.ledger.set(offerId, { status: 'disabled', reason: `${activity} 在配置中已禁用` })
        this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `跳过 "${activity}"（配置中已禁用） | offerId=${offerId}`)
    }
}
