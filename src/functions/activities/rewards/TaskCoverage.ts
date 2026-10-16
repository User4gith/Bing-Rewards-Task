import type { MicrosoftRewardsBot } from '../../../index'
import type { Counters, DashboardData } from '../../../interface/DashboardData'
import type { PageSnapshot } from '../../../browser/ReactFunc'
import { SearchProgress } from '../search/SearchProgress'
import { PromotionActivityRunner } from './PromotionActivityRunner'
import { TaskLedger } from './TaskLedger'
import { discoverTasks, isBonusSearchCard, promotionComplete, taskDate, type DiscoveredTask } from './TaskDiscovery'
import { observeAppTasks } from './AppTaskAudit'
import type { AppDashboardData } from '../../../interface/AppDashBoardData'

export class TaskCoverage {
    readonly ledger = new TaskLedger()
    private data: DashboardData | null = null
    private tasks: DiscoveredTask[] = []
    private snapshot: PageSnapshot | null = null

    constructor(private readonly bot: MicrosoftRewardsBot) {}

    reset(): void {
        this.ledger.reset()
        this.data = null
        this.tasks = []
        this.snapshot = null
        this.bot.browser.func.resetDashboardSource()
    }

    async scan(seed?: DashboardData): Promise<DiscoveredTask[]> {
        let freshData: DashboardData | null = null
        let freshSnapshot: PageSnapshot | null = null
        // These are independent sources. One transport failure must not discard the other.
        const results = await Promise.allSettled([
            seed ? Promise.resolve(seed) : this.bot.browser.func.getDashboardData(),
            this.bot.browser.func.refreshEarnSnapshot()
        ])
        const api = results[0]!
        if (api.status === 'fulfilled') {
            freshData = api.value
            this.data = freshData
            this.ledger.set('source:dashboard', {
                category: 'coverage',
                title: '仪表板任务来源',
                status: freshData.source && freshData.source !== 'primary' ? 'unverified' : 'complete',
                reason:
                    freshData.source && freshData.source !== 'primary'
                        ? '备用来源只能证明已发现任务，不能确认全量仪表板'
                        : '已获取主仪表板'
            })
        } else this.sourceFailure('dashboard', api.reason)

        const page = results[1]!
        if (page.status === 'fulfilled' && page.value) {
            freshSnapshot = page.value
            this.snapshot = freshSnapshot
            this.bot.reactSnapshot = freshSnapshot
            this.bot.reactSnapshots[this.bot.isMobile ? 'mobile' : 'desktop'] = freshSnapshot
            const authenticated = freshSnapshot.account.availablePoints !== null || freshSnapshot.account.level !== null
            this.ledger.set('source:pages', {
                category: 'coverage',
                title: 'Rewards 页面任务来源',
                status: authenticated && !freshSnapshot.missingSources?.length ? 'complete' : 'unverified',
                reason: !authenticated
                    ? '页面缺少可核验的账户数据'
                    : freshSnapshot.missingSources?.length
                      ? `部分页面获取失败：${freshSnapshot.missingSources.join(', ')}`
                      : '已刷新 /earn 与 /dashboard'
            })
        } else this.sourceFailure('pages', page.status === 'rejected' ? page.reason : '未取得页面快照')

        // Modern accounts may not expose the legacy primary API. A complete pair of
        // authenticated page payloads can supply the inventory; a partial flyout alone cannot.
        if (
            freshData?.source &&
            freshData.source !== 'primary' &&
            freshSnapshot?.offers.length &&
            this.ledger.get('source:pages')?.status === 'complete'
        ) {
            this.ledger.set('source:dashboard', {
                status: 'unavailable',
                reason: 'API 仅有部分数据；本轮任务清单由两个已认证 Rewards 页面补全'
            })
        }

        const data = freshData ?? this.data
        if (!data) {
            this.tasks = []
            return []
        }
        // Retain previously discovered IDs so a partial response cannot silently erase work.
        const byId = new Map(this.tasks.map(task => [task.promotion.offerId, task]))
        const discovered = discoverTasks(data, freshSnapshot ?? this.snapshot)
        const today = taskDate(this.bot.userData.timezoneOffset)
        for (const task of discovered) {
            byId.set(task.promotion.offerId, task)
            const record = this.ledger.observe(task, today)
            if (task.date && task.date < today) {
                this.ledger.set(record.id, { status: 'deferred', reason: `历史日期任务 ${task.date}，不计入今日目标` })
            }
        }
        this.tasks = [...byId.values()]
        for (const streak of freshSnapshot?.streaks ?? []) {
            this.ledger.set(`streak:${streak.partner}`, {
                title: `${streak.partner} 今日活动`,
                category: 'streak',
                sources: ['page'],
                pointsMax: streak.dailyPoints[Math.max(0, streak.currentDay - 1)] ?? 0,
                status: streak.isCurrentDayCompleted ? 'complete' : 'pending',
                reason: streak.isCurrentDayCompleted
                    ? '官网已记录今日连续任务'
                    : '今日连续任务尚未记录，需要相应活动执行器处理'
            })
        }
        this.observeSearch(data)
        return this.tasks
    }

    private sourceFailure(source: string, error: unknown): void {
        this.ledger.set(`source:${source}`, {
            category: 'coverage',
            status: 'unverified',
            reason: String(error instanceof Error ? error.message : error)
        })
    }

    async scanApp(seed?: AppDashboardData | null): Promise<void> {
        const w = this.bot.config.workers
        if (!w.doAppPromotions && !w.doDailyCheckIn && !w.doReadToEarn) return
        if (!this.bot.accessToken) {
            this.sourceFailure('app', 'App 访问令牌不可用，不能确认 App 积分任务')
            return
        }
        try {
            const data = seed ?? (await this.bot.browser.func.getAppDashboardData())
            if (!Array.isArray(data.response?.promotions)) throw new Error('App 任务列表缺失')
            observeAppTasks(data, this.ledger, this.bot.userData.timezoneOffset)
            this.ledger.set('source:app', {
                category: 'coverage',
                status: 'complete',
                reason: '已刷新 App 积分任务列表'
            })
        } catch (error) {
            this.sourceFailure('app', error)
        }
    }

    private observeSearch(data: DashboardData): void {
        const counters = data.dashboard.userStatus?.counters ?? ({} as Counters)
        const quotas = new SearchProgress(this.bot).calculateQuotas(counters)
        for (const platform of ['mobile', 'desktop'] as const) {
            const raw = platform === 'mobile' ? counters.mobileSearch : counters.pcSearch
            const quota =
                platform === 'mobile'
                    ? quotas.mobile
                    : {
                          known: quotas.desktop.known && quotas.edge.known,
                          earned: quotas.desktop.earned + quotas.edge.earned,
                          max: quotas.desktop.max + quotas.edge.max,
                          remaining: quotas.desktop.remaining + quotas.edge.remaining
                      }
            const enabled =
                platform === 'mobile' ? this.bot.config.workers.doMobileSearch : this.bot.config.workers.doDesktopSearch
            const known = Array.isArray(raw) && quota.known
            const previous = this.ledger.get(`search:${platform}`)
            this.ledger.set(`search:${platform}`, {
                title: `${platform === 'mobile' ? '移动端' : '桌面端'}搜索以赚取`,
                category: 'search',
                sources: [data.source ?? 'primary'],
                pointsMax: quota.max,
                pointsEarned: quota.earned,
                status: !known
                    ? 'unverified'
                    : quota.max === 0
                      ? 'unavailable'
                      : quota.remaining === 0
                        ? 'complete'
                        : !enabled
                          ? 'disabled'
                          : previous?.status === 'failed'
                            ? 'failed'
                            : 'pending',
                reason: !known
                    ? '搜索配额字段缺失，不能按 0/0 已完成处理'
                    : quota.max === 0
                      ? '官网当前未提供此平台积分配额'
                      : quota.remaining === 0
                        ? '官网搜索配额已满'
                        : !enabled
                          ? '配置禁用，但官网仍有剩余积分'
                          : `${previous?.status === 'failed' ? previous.reason + '；' : ''}官网剩余 ${quota.remaining} 分`
            })
        }
    }

    async run(
        group: 'dailySet' | 'more' | 'all',
        seed?: DashboardData,
        options: { cardsOnly?: boolean } = {}
    ): Promise<void> {
        this.data ??= seed ?? null
        const passes = this.bot.config.taskCoverage?.maxPasses ?? 3
        for (let pass = 0; pass < passes; pass++) {
            const tasks = await this.scan()
            const selected = tasks.filter(task => {
                const record = this.ledger.get(task.promotion.offerId)
                if (!record || ['complete', 'blocked', 'deferred', 'unavailable'].includes(record.status)) return false
                if (task.category === 'punchCards') return false
                if (group === 'dailySet' && task.category !== 'dailySet') return false
                if (group === 'more' && task.category === 'dailySet') return false
                // Theme searches are quick card activities. Ordinary bonus searches
                // use the long search loop and must wait until both platforms' cards ran.
                if (options.cardsOnly && isBonusSearchCard(task.promotion)) {
                    this.ledger.set(record.id, { reason: '普通奖励搜索安排在卡片优先阶段之后执行' })
                    return false
                }
                // Unsupported/disabled tasks remain visible, but are not retried without a state change.
                return record.status !== 'unsupported' && record.status !== 'disabled' && record.attempts < passes
            })
            if (!selected.length) break
            this.bot.logger.info(
                this.bot.isMobile,
                'TASK-COVERAGE',
                `任务补全 | 范围=${group} | 轮次=${pass + 1}/${passes} | 待执行=${selected.length}`
            )
            const before = this.ledger.list().filter(task => task.status === 'complete').length
            await new PromotionActivityRunner(this.bot).run(selected.map(task => task.promotion))
            await this.scan()
            const after = this.ledger.list().filter(task => task.status === 'complete').length
            if (after <= before) break
        }
    }

    async verify(offerId: string): Promise<boolean> {
        const checks = this.bot.config.taskCoverage?.verificationAttempts ?? 3
        let found = false
        for (let check = 0; check < checks; check++) {
            if (check > 0) await this.bot.utils.wait(2000 * check)
            let data: DashboardData | null = null
            let snapshot: PageSnapshot | null = null
            const results = await Promise.allSettled([
                this.bot.browser.func.getDashboardData(),
                this.bot.browser.func.refreshEarnSnapshot()
            ])
            if (results[0]!.status === 'fulfilled') data = results[0]!.value
            if (results[1]!.status === 'fulfilled') snapshot = results[1]!.value
            const api = data ? discoverTasks(data).find(task => task.promotion.offerId === offerId) : undefined
            const pageOffer = snapshot?.offers.find(offer => offer.offerId === offerId)
            found ||= !!api || !!pageOffer
            if ((api && promotionComplete(api.promotion)) || pageOffer?.isCompleted === true) {
                this.ledger.set(offerId, {
                    status: 'complete',
                    reason: '已刷新官网并核验该任务完成',
                    pointsEarned: api ? Number(api.promotion.pointProgress) : (pageOffer?.points ?? null)
                })
                return true
            }
        }
        const prior = this.ledger.get(offerId)
        const cause = prior && !['执行中', '等待执行和核验'].includes(prior.reason) ? `${prior.reason}；` : ''
        this.ledger.set(offerId, {
            status: 'unverified',
            reason: cause + (found ? '执行后官网仍未确认该任务完成' : '任务在刷新后的来源中缺失，不能据此判定完成')
        })
        return false
    }

    needsBrowserRetry(): boolean {
        const limit = this.bot.config.taskCoverage?.maxPasses ?? 3
        return this.ledger
            .unresolved()
            .some(
                task =>
                    !['coverage', 'search', 'app', 'streak', 'edgeBrowsing'].includes(task.category) &&
                    !['unsupported', 'disabled'].includes(task.status) &&
                    task.attempts < limit
            )
    }

    async finish(accountEmail: string): Promise<ReturnType<TaskLedger['summary']>> {
        await this.scan()
        await this.scanApp()
        for (const task of this.ledger.unresolved()) {
            this.bot.logger.warn(
                'main',
                'TASK-UNRESOLVED',
                `任务未完成 | id=${task.id} | 分类=${task.category} | 标题=${task.title} | 状态=${task.status} | 原因=${task.reason}`
            )
        }
        const summary = this.ledger.summary()
        const report = this.ledger.save(accountEmail)
        this.bot.logger.info(
            'main',
            'TASK-AUDIT',
            `任务验收 | 状态=${summary.complete ? '全部已核验' : '仍有未完成或待核验项'} | 总数=${summary.total} | 已核验=${summary.verified} | 未解决=${summary.unresolved} | 不适用=${summary.excluded} | 报告=${report}`
        )
        return summary
    }
}
