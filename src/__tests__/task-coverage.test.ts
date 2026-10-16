import test from 'node:test'
import assert from 'node:assert/strict'
import type { MicrosoftRewardsBot } from '../index'
import type { Dashboard, DashboardData, BasePromotion } from '../interface/DashboardData'
import type { Config } from '../interface/Config'
import type { PageSnapshot } from '../browser/ReactFunc'
import example from '../../config.example.json'
import { TaskCoverage } from '../functions/activities/rewards/TaskCoverage'
import { TaskLedger } from '../functions/activities/rewards/TaskLedger'
import { collectPromotions, taskDate } from '../functions/activities/rewards/TaskDiscovery'
import { DailySet } from '../functions/activities/rewards/DailySet'
import { MorePromotions } from '../functions/activities/rewards/MorePromotions'
import { PunchCards } from '../functions/activities/rewards/PunchCards'
import { SearchProgress } from '../functions/activities/search/SearchProgress'
import { Search } from '../functions/activities/search/BrowserSearch'
import { mapFlyoutToDashboard } from '../browser/FlyoutDashboard'
import { applyTaskCoverageConfig } from '../util/TaskCoverageConfig'
import { observeAppTasks } from '../functions/activities/rewards/AppTaskAudit'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import { MicrosoftRewardsBot as BotClass } from '../index'
import { safeCardDestination } from '../functions/activities/rewards/BrowserCard'
import { LegacyQuiz } from '../functions/activities/rewards/LegacyQuiz'
import { SearchManager } from '../functions/activities/search/SearchManager'

function promotion(id: string, extra: Record<string, unknown> = {}): BasePromotion {
    return {
        offerId: id,
        name: id,
        title: id,
        promotionType: 'urlreward',
        pointProgress: 0,
        pointProgressMax: 10,
        complete: false,
        priority: 0,
        attributes: {},
        hash: 'signed',
        activityType: '11',
        ...extra
    } as unknown as BasePromotion
}

function fixture(extra: Record<string, unknown> = {}) {
    const events: string[] = [],
        executed: string[] = []
    const dashboard = {
        userStatus: { availablePoints: 100, counters: { pcSearch: [], mobileSearch: [] } },
        dailySetPromotions: {},
        morePromotions: [],
        morePromotionsWithoutPromotionalItems: [],
        punchCards: [],
        ...extra
    } as unknown as Dashboard
    const data = { dashboard, source: 'primary' } as DashboardData
    const snapshot: PageSnapshot = {
        offers: [],
        reportable: [],
        streaks: [],
        streakProtection: null,
        account: { availablePoints: 100, level: 1, pointsProgress: 0, pointsRemaining: 0, lifetimeEarn: 100 }
    }
    const bot = {
        isMobile: true,
        currentAccountEmail: 'test@example.invalid',
        config: applyTaskCoverageConfig(structuredClone(example) as Config),
        userData: { currentPoints: 100, gainedPoints: 0, timezoneOffset: '-480' },
        logger: Object.fromEntries(
            ['info', 'warn', 'error', 'debug'].map(level => [
                level,
                (...args: unknown[]) => events.push(String(args[2]))
            ])
        ),
        utils: { wait: async () => {}, randomDelay: () => 0 },
        reactSnapshot: snapshot,
        reactSnapshots: { mobile: snapshot, desktop: null },
        mainMobilePage: { isClosed: () => false, goto: async () => {} },
        mainDesktopPage: { isClosed: () => false, goto: async () => {} },
        nextActions: { reportActivity: 'test-action' },
        cookies: { mobile: [], desktop: [] },
        browser: {
            func: {
                getDashboardData: async () => data,
                refreshEarnSnapshot: async () => snapshot,
                resetDashboardSource() {}
            },
            react: { questRouterStateTree: () => '' }
        },
        activities: {
            doUrlReward: async (p: BasePromotion) => {
                executed.push(p.offerId)
                p.complete = true
                p.pointProgress = p.pointProgressMax
            },
            doSearchOnBing: async (p: BasePromotion) => {
                executed.push(p.offerId)
                p.complete = true
            },
            doVisualSearch: async () => 0
        }
    } as unknown as MicrosoftRewardsBot
    bot.taskCoverage = new TaskCoverage(bot)
    bot.config.taskCoverage!.verificationAttempts = 1
    return { bot, dashboard, data, snapshot, events, executed }
}

test('discovers and deduplicates every activity pool, including future pool names and children', () => {
    const a = promotion('same')
    const tasks = collectPromotions({
        dailySetPromotions: { '10/16/2026': [a] },
        morePromotions: [structuredClone(a)],
        dailyActivities: [promotion('daily')],
        moreActivities: [promotion('more')],
        promotionalItems: [promotion('promo')],
        newlyIntroducedPromotions: [promotion('new')],
        punchCards: [{ parentPromotion: promotion('parent'), childPromotions: [promotion('child')] }],
        suggestedRewards: [promotion('redemption')],
        userStatus: { counters: { pcSearch: [promotion('quota')] } }
    } as unknown as Dashboard)
    assert.deepEqual(
        new Set(tasks.map(t => t.promotion.offerId)),
        new Set(['same', 'daily', 'more', 'promo', 'new', 'parent', 'child'])
    )
    assert.equal(tasks.find(t => t.promotion.offerId === 'child')?.parentId, 'parent')
    assert.equal(tasks.find(t => t.promotion.offerId === 'same')?.date, '2026-10-16')
})

test('daily set and more activities execute production runners, including promotional and negative priority tasks', async () => {
    const today = taskDate('-480').split('-')
    const f = fixture({
        dailySetPromotions: { [`${today[1]}/${today[2]}/${today[0]}`]: [promotion('dailyset')] },
        dailyActivities: [promotion('dailyactivity')],
        morePromotions: [promotion('more')],
        promotionalItems: [promotion('promo', { priority: -10, attributes: { promotional: 'True' } })]
    })
    await new DailySet(f.bot).run(f.data)
    await new MorePromotions(f.bot).run(f.data)
    assert.deepEqual(new Set(f.executed), new Set(['dailyset', 'dailyactivity', 'more', 'promo']))
    assert.equal(f.executed.length, 4)
    assert.equal(f.bot.taskCoverage.ledger.unresolved().length, 0)
})

test('empty discovery never logs that every daily activity is completed', async () => {
    const f = fixture()
    await new DailySet(f.bot).run(f.data)
    await new MorePromotions(f.bot).run(f.data)
    assert.equal(f.executed.length, 0)
    assert.equal(
        f.events.some(message => /所有.*已完成/.test(message)),
        false
    )
})

test('newly unlocked card is discovered in a subsequent pass', async () => {
    const f = fixture({ morePromotions: [promotion('first')] })
    f.bot.activities.doUrlReward = async p => {
        f.executed.push(p.offerId)
        p.complete = true
        if (p.offerId === 'first')
            f.dashboard.morePromotions.push(promotion('unlocked') as (typeof f.dashboard.morePromotions)[number])
    }
    await f.bot.taskCoverage.run('all')
    assert.deepEqual(f.executed, ['first', 'unlocked'])
})

test('balance gain, HTTP acceptance and disappearing tasks cannot verify completion', async () => {
    const f = fixture({ morePromotions: [promotion('uncredited')] })
    f.bot.activities.doUrlReward = async () => {
        f.bot.userData.currentPoints += 100
    }
    await f.bot.taskCoverage.run('all')
    assert.equal(f.bot.taskCoverage.ledger.get('uncredited')?.status, 'unverified')
    f.dashboard.morePromotions = []
    assert.equal(await f.bot.taskCoverage.verify('uncredited'), false)
})

test('unsupported, locked and future cards retain an explicit disposition', async () => {
    const f = fixture({
        morePromotions: [
            promotion('unsupported', { promotionType: 'new-type' }),
            promotion('locked', { exclusiveLockedFeatureStatus: 'locked' }),
            promotion('future', { date: '2099-01-01' })
        ]
    })
    await f.bot.taskCoverage.run('all')
    assert.equal(f.bot.taskCoverage.ledger.get('unsupported')?.status, 'unsupported')
    assert.equal(f.bot.taskCoverage.ledger.get('locked')?.status, 'blocked')
    assert.equal(f.bot.taskCoverage.ledger.get('future')?.status, 'deferred')
    assert.equal(f.bot.taskCoverage.ledger.summary().complete, false)
})

test('flyout extra cards reach the execution queue and partial coverage remains explicit', async () => {
    const f = fixture()
    const mapped = mapFlyoutToDashboard({
        userInfo: { isRewardsUser: true, balance: 100, profile: { attributes: {} } as never },
        flyoutResult: {
            userStatus: { isRewardsUser: true, counters: {} },
            exploreOnBingPromotions: [promotion('exploreonbing_demo')]
        }
    })
    f.bot.browser.func.getDashboardData = async () => mapped
    await f.bot.taskCoverage.run('all')
    assert.deepEqual(f.executed, ['exploreonbing_demo'])
    assert.equal(f.bot.taskCoverage.ledger.get('source:dashboard')?.status, 'unverified')
    assert.equal(f.bot.taskCoverage.ledger.get('search:desktop')?.status, 'unverified')
})

test('missing quota is unknown, explicit empty quota is unavailable and real quota is calculable', () => {
    const f = fixture(),
        progress = new SearchProgress(f.bot)
    assert.equal(progress.calculateQuotas({} as never).desktop.known, false)
    assert.throws(() => progress.calculateMissing({} as never, false), /配额缺失/)
    assert.equal(progress.calculateQuotas({ pcSearch: [], mobileSearch: [] } as never).desktop.known, true)
    assert.equal(
        progress.calculateMissing(
            { pcSearch: [promotion('pc', { pointProgressMax: 30, pointProgress: 12 })] } as never,
            false
        ).totalPoints,
        18
    )
    assert.throws(
        () =>
            progress.calculateMissing({ pcSearch: [promotion('pc', { pointProgressMax: 'invalid' })] } as never, false),
        /配额缺失/
    )
})

test('403 during a search session is recorded as incomplete, never completed', async () => {
    const f = fixture()
    f.bot.browser.func.getDashboardData = async () => {
        throw new Error('Proxy rejected CONNECT: 403')
    }
    await new Search(f.bot).doSearch(f.bot.mainMobilePage, true)
    assert.equal(f.bot.taskCoverage.ledger.get('search:mobile')?.status, 'failed')
    assert.equal(
        f.events.some(message => /必应搜索完成/.test(message)),
        false
    )
    assert.equal(
        f.events.some(message => /403/.test(message)),
        true
    )
})

test('API punchcard children execute even when /earn HTML is unavailable', async () => {
    const parent = promotion('pcparent_demo'),
        child = promotion('pcchild_demo')
    const f = fixture({ punchCards: [{ parentPromotion: parent, childPromotions: [child] }] })
    f.bot.browser.func.getRewardsPageHtml = async () => null
    f.bot.browser.func.reportServerAction = async () => {
        f.executed.push(child.offerId)
        child.complete = true
        parent.complete = true
        return { status: 200, acknowledged: true, availablePoints: 110 }
    }
    await new PunchCards(f.bot).runMobile(f.data)
    assert.deepEqual(f.executed, ['pcchild_demo'])
    assert.equal(f.bot.taskCoverage.ledger.get(parent.offerId)?.status, 'complete')
    assert.equal(f.bot.taskCoverage.ledger.get(child.offerId)?.status, 'complete')
    assert.equal(f.bot.taskCoverage.ledger.get('source:punchCards')?.status, 'unverified')
})

test('full coverage enables every supported worker, removes partial targets and leaves TLS intact', () => {
    const config = structuredClone(example) as Config
    config.workers.doDailySet = false
    config.workers.doMorePromotions = false
    const result = applyTaskCoverageConfig(config)
    assert.ok(Object.values(result.workers).every(Boolean))
    assert.equal(result.skipNonPointTasks, false)
    assert.equal(result.autoClaimPunchcardRewards, true)
    assert.equal(result.humanize?.searchTargetRatio?.min, 1)
    assert.equal(result.humanize?.skipWhenCompletedToday, false)
    assert.equal(result.proxy.ignoreCertificateErrors, false)
    assert.equal(config.workers.doDailySet, false)
    config.taskCoverage!.enabled = false
    assert.equal(applyTaskCoverageConfig(config), config)
})

test('account day is correct across UTC midnight and uses the configured browser offset', () => {
    assert.equal(taskDate('-480', Date.parse('2026-10-15T17:00:00Z')), '2026-10-16')
    assert.equal(taskDate('0', Date.parse('2026-10-15T17:00:00Z')), '2026-10-15')
})

test('App tasks use per-offer progress rather than aggregate balance', () => {
    const ledger = new TaskLedger()
    observeAppTasks(
        {
            response: {
                promotions: [
                    { attributes: { offerid: 'read', type: 'msnreadearn', pointmax: '30', pointprogress: '12' } },
                    { attributes: { offerid: 'done', type: 'sapphire', complete: 'true', pointmax: '10' } },
                    { attributes: { offerid: 'new', type: 'new-app-task', pointmax: '10' } }
                ]
            }
        } as unknown as AppDashboardData,
        ledger,
        '-480'
    )
    assert.equal(ledger.get('app:read')?.status, 'pending')
    assert.equal(ledger.get('app:done')?.status, 'complete')
    assert.equal(ledger.get('app:new')?.status, 'unsupported')
})

test('incomplete account result propagates to the actual single-process exit status', async () => {
    const f = fixture()
    Object.setPrototypeOf(f.bot, BotClass.prototype)
    f.bot.utils.getEmailUsername = () => 'test'
    const target = f.bot as unknown as {
        Main: () => Promise<unknown>
        runTasks: (accounts: unknown[], start: number) => Promise<unknown>
    }
    target.Main = async () => ({ initialPoints: 100, collectedPoints: 3, tasksComplete: false, remainingTasks: 1 })
    const originalExit = process.exit
    let code: number | undefined
    process.exit = ((value: number) => {
        code = value
        throw new Error('captured-exit')
    }) as never
    try {
        await assert.rejects(
            target.runTasks(
                [
                    {
                        email: 'test@example.invalid',
                        langCode: 'en',
                        geoLocale: 'CN',
                        proxy: { proxyHttp: false, url: '', port: 0 }
                    }
                ],
                Date.now()
            ),
            /captured-exit/
        )
        assert.equal(code, 1)
        assert.ok(f.events.some(event => event.startsWith('账户未完成')))
    } finally {
        process.exit = originalExit
    }
})

test('browser card fallback accepts first-party earning URLs and rejects redemption and unrelated sites', () => {
    assert.equal(safeCardDestination(undefined as unknown as string), null)
    assert.equal(safeCardDestination(''), null)
    assert.equal(safeCardDestination('https://www.bing.com/search?q=test'), 'https://www.bing.com/search?q=test')
    for (const url of [
        'http://www.bing.com/search',
        'https://bing.com.evil.invalid/search',
        'https://rewards.bing.com/redeem/reward',
        'https://account.microsoft.com/billing/checkout'
    ])
        assert.equal(safeCardDestination(url), null)
})

test('one failed card does not prevent other cards from executing', async () => {
    const f = fixture({ morePromotions: [promotion('bad'), promotion('good')] })
    f.bot.activities.doUrlReward = async p => {
        if (p.offerId === 'bad') throw new Error('temporary transport failure')
        f.executed.push(p.offerId)
        p.complete = true
    }
    await f.bot.taskCoverage.run('all')
    assert.deepEqual(f.executed, ['good'])
    assert.equal(f.bot.taskCoverage.ledger.get('bad')?.status, 'failed')
    assert.equal(f.bot.taskCoverage.ledger.get('good')?.status, 'complete')
})

test('search planning failure remains unknown while other activity modules can proceed', async () => {
    const f = fixture()
    f.bot.browser.func.getDashboardData = async () => {
        throw new Error('quota endpoint unavailable')
    }
    const plan = await new SearchManager(f.bot).getSearchPoints()
    assert.equal(plan.doDesktop, false)
    assert.equal(f.bot.taskCoverage.ledger.get('search:desktop')?.status, 'unverified')
})

test('authenticated complete page inventory can replace an unavailable legacy primary API', async () => {
    const f = fixture({ morePromotions: [promotion('modern-card')] })
    f.data.source = 'flyout'
    f.snapshot.offers.push({
        offerId: 'modern-card',
        hash: 'signed',
        points: 10,
        title: 'modern-card',
        description: '',
        destination: '',
        isCompleted: true,
        isPromotional: false,
        isLocked: false,
        unlockCriteria: null,
        promotionSubtype: null,
        date: null,
        activityType: 11,
        reportable: false
    })
    await f.bot.taskCoverage.scan()
    assert.equal(f.bot.taskCoverage.ledger.get('source:dashboard')?.status, 'unavailable')
    f.snapshot.missingSources = ['/dashboard']
    await f.bot.taskCoverage.scan()
    assert.equal(f.bot.taskCoverage.ledger.get('source:dashboard')?.status, 'unverified')
})

test('legacy quiz stops after stagnation and confirms progress before repeating', async () => {
    const quiz = promotion('quiz', { promotionType: 'quiz', pointProgressMax: 20 })
    const f = fixture({ morePromotions: [quiz] })
    Object.defineProperty(f.bot, 'fingerprint', { value: { headers: {} } })
    f.bot.browser.func.buildCookieHeader = () => ''
    let requests = 0
    f.bot.http = {
        request: async () => {
            requests++
            quiz.pointProgress += 10
            return { status: 200 }
        }
    } as unknown as MicrosoftRewardsBot['http']
    await new LegacyQuiz(f.bot).run(quiz)
    assert.equal(requests, 2)
    quiz.pointProgress = 0
    f.bot.http.request = async () => {
        requests++
        return { status: 200 } as never
    }
    await new LegacyQuiz(f.bot).run(quiz)
    assert.equal(requests, 3)
})

test('failure in one punchcard child does not skip its siblings', async () => {
    const parent = promotion('pcparent_siblings'),
        bad = promotion('pcchild_bad'),
        good = promotion('pcchild_good')
    const f = fixture({ punchCards: [{ parentPromotion: parent, childPromotions: [bad, good] }] })
    f.bot.browser.func.getRewardsPageHtml = async () => null
    f.bot.browser.func.reportServerAction = async (_action, args) => {
        const id = (args[2] as { offerid: string }).offerid
        if (id === bad.offerId) throw new Error('child transport failure')
        f.executed.push(id)
        good.complete = true
        return { status: 200, acknowledged: true, availablePoints: 110 }
    }
    await new PunchCards(f.bot).runMobile(f.data)
    assert.deepEqual(f.executed, ['pcchild_good'])
    assert.equal(f.bot.taskCoverage.ledger.get(good.offerId)?.status, 'complete')
    assert.notEqual(f.bot.taskCoverage.ledger.get(parent.offerId)?.status, 'complete')
})
