import { URLs } from '../../../constants/urls'
import { BaseActivity } from '../BaseActivity'
import type { ParentQuest, QuestChild } from '../../../browser/ReactFunc'
import type { BasePromotion, DashboardData, PunchCard } from '../../../interface/DashboardData'
import { isLockedPromotion, promotionComplete } from './TaskDiscovery'

export class PunchCards extends BaseActivity {
    async runMobile(data: DashboardData): Promise<void> {
        await this.run(data)
    }

    async runDesktop(): Promise<void> {
        if (!this.bot.config.workers.doPunchCards) return
        try {
            await this.run(await this.bot.browser.func.getDashboardData(this.bot.cookies.desktop))
        } catch (error) {
            this.failure('source:punchCards', error)
        }
    }

    private failure(id: string, error: unknown): void {
        const reason = error instanceof Error ? error.message : String(error)
        this.bot.taskCoverage.ledger.set(id, { status: 'unverified', category: 'punchCards', reason })
        this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `任务未核验 | id=${id} | 原因=${reason}`)
    }

    private async run(data: DashboardData): Promise<void> {
        const ledger = this.bot.taskCoverage.ledger
        const apiCards = data.dashboard.punchCards ?? []
        const apiById = new Map(
            apiCards.filter(card => card.parentPromotion?.offerId).map(card => [card.parentPromotion.offerId, card])
        )
        let pages: Array<string | null> = []
        try {
            pages = await Promise.all([
                this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn'),
                this.bot.browser.func.getRewardsPageHtml(URLs.rewards.dashboard, '/dashboard')
            ])
        } catch (error) {
            this.failure('source:punchCards', error)
        }
        const html = pages.filter((page): page is string => !!page)
        const parents = new Map(
            (html.length ? this.bot.browser.react.snapshotQuestList(...html) : []).map(parent => [
                parent.offerId,
                parent
            ])
        )
        // API tasks remain executable even if HTML discovery fails.
        for (const [id, card] of apiById) {
            const p = card.parentPromotion
            parents.set(id, {
                offerId: id,
                title: p.title || parents.get(id)?.title || id,
                pointProgressMax: Number(p.pointProgressMax) || parents.get(id)?.pointProgressMax || 0,
                complete: promotionComplete(p)
            })
        }
        ledger.set('source:punchCards', {
            title: '多步骤卡片任务来源',
            category: 'coverage',
            status: html.length ? 'complete' : 'unverified',
            reason: html.length ? '已合并页面任务和 API 卡片' : '卡片页面不可用；保留 API 任务，但不能确认全量卡片'
        })

        for (const parent of parents.values()) {
            ledger.set(parent.offerId, {
                title: parent.title,
                category: 'punchCards',
                pointsMax: parent.pointProgressMax,
                status: parent.complete ? 'complete' : 'pending',
                reason: parent.complete ? '官网父卡片已完成' : '等待执行子任务'
            })
            if (parent.complete) continue
            if (this.bot.config.skipNonPointTasks && parent.pointProgressMax <= 0) {
                ledger.set(parent.offerId, { status: 'disabled', reason: '配置跳过零分父任务，可能包含有积分的子项' })
                continue
            }
            try {
                await this.solve(parent, apiById.get(parent.offerId))
            } catch (error) {
                this.failure(parent.offerId, error)
            }
        }
        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `卡片检查结束 | 发现父任务=${parents.size} | 结果以逐项验收为准`
        )
    }

    private fromApi(p: BasePromotion): QuestChild {
        const hash = typeof p.hash === 'string' && p.hash !== '$undefined' ? p.hash : null
        const complete = promotionComplete(p)
        const locked = isLockedPromotion(p)
        return {
            offerId: p.offerId,
            title: p.title,
            hash,
            points: Number(p.pointProgressMax) || 0,
            activityType:
                Number.isInteger(Number(p.activityType)) && Number(p.activityType) > 0 ? Number(p.activityType) : null,
            isCompleted: complete,
            isLocked: locked,
            isDisabled: false,
            reportable: !!hash && !complete && !locked
        }
    }

    private async children(parent: ParentQuest, api?: PunchCard): Promise<QuestChild[]> {
        const byId = new Map<string, QuestChild>()
        try {
            const html = await this.bot.browser.func.getRewardsPageHtml(
                URLs.rewards.quest(parent.offerId),
                `/earn/quest/${parent.offerId}`
            )
            if (html) for (const child of this.bot.browser.react.snapshotQuestPage(html)) byId.set(child.offerId, child)
        } catch (error) {
            this.failure(parent.offerId, error)
        }
        for (const p of api?.childPromotions ?? []) {
            if (!p.offerId) continue
            const candidate = this.fromApi(p)
            const htmlChild = byId.get(p.offerId)
            if (htmlChild) {
                candidate.hash ||= htmlChild.hash
                candidate.activityType ??= htmlChild.activityType
                candidate.isCompleted ||= htmlChild.isCompleted
                candidate.isLocked ||= htmlChild.isLocked
                candidate.reportable = !!candidate.hash && !candidate.isCompleted && !candidate.isLocked
            }
            byId.set(p.offerId, candidate)
        }
        return [...byId.values()]
    }

    private async refreshedCard(id: string): Promise<PunchCard | undefined> {
        const data = await this.bot.browser.func.getDashboardData()
        return data.dashboard.punchCards?.find(card => card.parentPromotion?.offerId === id)
    }

    private async solve(parent: ParentQuest, initial?: PunchCard): Promise<void> {
        const ledger = this.bot.taskCoverage.ledger
        let api = initial
        for (let pass = 0; pass < (this.bot.config.taskCoverage?.maxPasses ?? 3); pass++) {
            const children = await this.children(parent, api)
            if (!children.length) {
                this.failure(parent.offerId, '未获取到子任务，不能视为已完成')
                return
            }
            const apiById = new Map((api?.childPromotions ?? []).map(p => [p.offerId, p]))
            children.sort(
                (a, b) =>
                    Number(this.isClaim(a.offerId)) - Number(this.isClaim(b.offerId)) ||
                    (apiById.get(a.offerId)?.priority ?? 0) - (apiById.get(b.offerId)?.priority ?? 0)
            )
            let progressed = false
            for (const child of children) {
                ledger.set(child.offerId, {
                    title: child.title || child.offerId,
                    category: 'punchCards',
                    pointsMax: child.points,
                    status: child.isCompleted ? 'complete' : child.isLocked || child.isDisabled ? 'blocked' : 'pending',
                    reason: child.isCompleted
                        ? '官网子任务已完成'
                        : child.isLocked || child.isDisabled
                          ? '官网子任务锁定或禁用'
                          : '待执行'
                })
                if (child.isCompleted || child.isLocked || child.isDisabled) continue
                const promotion = apiById.get(child.offerId)
                if (
                    (promotion?.promotionType ?? '').toLowerCase() === 'search' ||
                    /search.*(?:day|streak)|(?:day|streak).*search/i.test(child.offerId)
                ) {
                    const multiDay = Number(promotion?.activityProgressMax) > 1 && /day|streak/i.test(child.offerId)
                    ledger.set(child.offerId, {
                        status: multiDay ? 'deferred' : 'pending',
                        reason: multiDay ? '多天累计任务，不能在一天内提前完成' : '依赖实际搜索配额，搜索结束后再次检查'
                    })
                    continue
                }
                if (this.isClaim(child.offerId) && !this.bot.config.autoClaimPunchcardRewards) {
                    ledger.set(child.offerId, { status: 'disabled', reason: '配置禁止自动领取已赚取的卡片积分' })
                    continue
                }
                if (!child.reportable || !child.hash || !this.bot.nextActions.reportActivity) {
                    this.failure(child.offerId, '缺少可执行的 hash 或 reportActivity 元数据')
                    continue
                }
                ledger.attempt(child.offerId)
                const url = URLs.rewards.quest(parent.offerId)
                try {
                    await this.bot.browser.func.reportServerAction(
                        this.bot.nextActions.reportActivity,
                        [
                            child.hash,
                            child.activityType ?? 11,
                            {
                                offerid: child.offerId,
                                isPromotional: '$undefined',
                                timezoneOffset: this.bot.userData.timezoneOffset
                            }
                        ],
                        {
                            url,
                            referer: url,
                            routerStateTree: this.bot.browser.react.questRouterStateTree(parent.offerId)
                        }
                    )
                    await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
                    const freshApi = await this.refreshedCard(parent.offerId)
                    const freshChildren = await this.children(parent, freshApi)
                    if (freshChildren.find(p => p.offerId === child.offerId)?.isCompleted) {
                        ledger.set(child.offerId, { status: 'complete', reason: '上报后已刷新官网核验子任务完成' })
                        progressed = true
                    } else this.failure(child.offerId, '上报后官网未确认子任务完成')
                    api = freshApi ?? api
                } catch (error) {
                    this.failure(child.offerId, error)
                }
            }
            api = (await this.refreshedCard(parent.offerId)) ?? api
            if (api && promotionComplete(api.parentPromotion)) {
                ledger.set(parent.offerId, { status: 'complete', reason: '已刷新官网核验父卡片完成' })
                return
            }
            if (!progressed) break
        }
        const remaining = (await this.children(parent, api)).filter(child => !child.isCompleted)
        if (
            remaining.length &&
            remaining.every(child => ['deferred', 'blocked'].includes(ledger.get(child.offerId)?.status ?? ''))
        ) {
            ledger.set(parent.offerId, {
                status: 'deferred',
                reason: '多天累计或官网锁定条件尚未满足，今日可执行子项已处理'
            })
        } else this.failure(parent.offerId, '父卡片仍未完成；检查子项、领取条件或多天累计要求')
    }

    private isClaim(id: string): boolean {
        return /(redeem|claim|(?<!url)reward)/i.test(id)
    }
}
