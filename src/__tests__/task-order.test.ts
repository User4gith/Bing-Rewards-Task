import test from 'node:test'
import assert from 'node:assert/strict'
import { MicrosoftRewardsBot } from '../index'
import type { Account } from '../interface/Account'
import type { Config } from '../interface/Config'
import example from '../../config.example.json'
import { TaskLedger } from '../functions/activities/rewards/TaskLedger'

interface Mode {
    name: string
    apiSearch: boolean
    apiCards: boolean
    parallel: boolean
}

const modes: Mode[] = [
    { name: 'sequential browser', apiSearch: false, apiCards: false, parallel: false },
    { name: 'parallel browser', apiSearch: false, apiCards: false, parallel: true },
    { name: 'API searches with browser cards', apiSearch: true, apiCards: false, parallel: false },
    { name: 'full API', apiSearch: true, apiCards: true, parallel: false }
]

function fixture(mode: Mode, options: { desktopOnlyQuota?: boolean; appUnavailable?: boolean } = {}) {
    const events: string[] = []
    const pages: Array<{ closed: boolean }> = []
    const bot = Object.create(MicrosoftRewardsBot.prototype) as MicrosoftRewardsBot
    const config = structuredClone(example) as Config
    config.prewarmDesktopLogin = false
    config.ensureStreakProtection = true
    config.experimental = {
        ...config.experimental,
        apiSearch: mode.apiSearch,
        apiSearchOnBing: mode.apiCards,
        edgeBrowsing: false
    }
    config.searchSettings.parallelSearching = mode.parallel
    for (const key of Object.keys(config.workers) as Array<keyof Config['workers']>) config.workers[key] = true
    config.taskCoverage = { enabled: true, maxPasses: 1, verificationAttempts: 1, timeZone: 'Asia/Shanghai' }
    const account = { email: 'order-test@example.invalid', langCode: 'en', geoLocale: 'CN' } as Account
    const data = {
        dashboard: {
            userProfile: { attributes: { country: 'CN' } },
            userStatus: { availablePoints: 100, counters: { mobileSearch: [], pcSearch: [] } }
        }
    }
    const appData = { response: { promotions: [] } }
    let mobileDone = false,
        desktopDone = false
    const card = async (name: string) => {
        events.push(`card:${name}:${bot.isMobile ? 'mobile' : 'desktop'}`)
        return 0
    }
    Object.assign(bot, {
        config,
        userData: {},
        utils: { wait: async () => {}, randomDelay: () => 0 },
        logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}])),
        http: { setDefaultHeaders() {} },
        browserFactory: {
            generateFingerprint: async () => ({ headers: {} }),
            createBrowser: async () => {
                const page = {
                    closed: false,
                    isClosed: () => page.closed,
                    evaluate: async () => -480
                }
                pages.push(page)
                return {
                    fingerprint: { headers: {} },
                    context: { page, newPage: async () => page, cookies: async () => [] }
                }
            }
        },
        login: {
            login: async () => {},
            getAppAccessToken: async () => (options.appUnavailable ? '' : 'test-only-token')
        },
        browser: {
            func: {
                checkpointActiveSession: async () => {},
                closeBrowser: async (context: { page: { closed: boolean } }) => {
                    context.page.closed = true
                },
                getDashboardData: async () => data,
                getAppDashboardData: async () => appData,
                getBrowserEarnablePoints: async () => ({ mobileSearchPoints: 30, desktopSearchPoints: 90 }),
                getAppEarnablePoints: async () => ({ totalEarnablePoints: 30 }),
                getCurrentPoints: async () => 100
            }
        },
        taskCoverage: {
            ledger: new TaskLedger(),
            reset() {},
            scan: async () => {},
            scanApp: async () => {},
            needsBrowserRetry: () => false,
            run: async (_group: string, _seed: unknown, settings?: { cardsOnly?: boolean }) => {
                events.push(`${settings?.cardsOnly ? 'cardscan' : 'reconcile'}:${bot.isMobile ? 'mobile' : 'desktop'}`)
            },
            finish: async () => ({ complete: true, unresolved: 0 })
        },
        activities: {
            doEnsureStreakProtection: () => card('streak'),
            doDailySet: () => card('daily-set'),
            doActivateSearchPerk: () => card('perk'),
            doMorePromotions: () => card('explore-and-more'),
            doDailyCheckIn: () => card('check-in'),
            doAppPromotions: () => card('app'),
            doPunchCardsMobile: () => card('punch'),
            doPunchCardsDesktop: () => card('punch'),
            doVisualSearch: () => card('visual'),
            doClaimBonusPoints: () => card('claim'),
            doReadToEarn: async () => {
                events.push('earn:read')
            }
        },
        searchManager: {
            getSearchPoints: async () => ({
                doMobile: config.workers.doMobileSearch && !mobileDone,
                doDesktop:
                    config.workers.doDesktopSearch && !desktopDone && (!options.desktopOnlyQuota || !bot.isMobile)
            }),
            searchMobile: async () => {
                if (!mode.apiSearch) assert.equal(bot.mainMobilePage.isClosed(), false)
                events.push('earn:mobile-search')
                mobileDone = true
                return 3
            },
            searchDesktop: async () => {
                if (!mode.apiSearch) assert.equal(bot.mainDesktopPage.isClosed(), false)
                events.push('earn:desktop-search')
                desktopDone = true
                return 3
            },
            bonusMobile: async () => {
                if (!mode.apiSearch) assert.equal(bot.mainMobilePage.isClosed(), false)
                events.push('earn:bonus-search')
                return 3
            }
        }
    })
    return { bot, config, account, events, pages }
}

for (const mode of modes) {
    test(`${mode.name}: both platforms' cards and claims precede all quota searches and reading`, async () => {
        const f = fixture(mode)
        const result = await f.bot.Main(f.account)
        const firstEarning = f.events.findIndex(event => event.startsWith('earn:'))
        for (const event of [
            'card:daily-set:mobile',
            'card:explore-and-more:mobile',
            'card:check-in:mobile',
            'card:app:mobile',
            'card:punch:mobile',
            'card:punch:desktop',
            'card:visual:desktop',
            'cardscan:mobile',
            'cardscan:desktop',
            'card:claim:mobile'
        ]) {
            const index = f.events.indexOf(event)
            assert.ok(index >= 0 && index < firstEarning, `${event} must precede earning: ${f.events.join(', ')}`)
        }
        const earnings = f.events.filter(event => event.startsWith('earn:'))
        assert.equal(earnings.at(-1), 'earn:read')
        assert.deepEqual(
            new Set(earnings),
            new Set(['earn:mobile-search', 'earn:desktop-search', 'earn:bonus-search', 'earn:read'])
        )
        assert.ok(f.events.some((event, index) => index > firstEarning && event.startsWith('reconcile:')))
        assert.ok(
            f.pages.every(page => page.closed),
            'all browser sessions must close'
        )
        assert.equal(result.tasksComplete, true)
    })
}

for (const mode of modes) {
    test(`${mode.name}: a desktop-only quota discovered during card preflight is still searched`, async () => {
        const f = fixture(mode, { desktopOnlyQuota: true })
        await f.bot.Main(f.account)
        assert.equal(f.events.filter(event => event === 'earn:desktop-search').length, 1)
        assert.ok(f.events.indexOf('cardscan:desktop') < f.events.indexOf('earn:desktop-search'))
    })
}

test('an unavailable App does not delay browser cards or prevent ordinary searches', async () => {
    const f = fixture(modes[0]!, { appUnavailable: true })
    await f.bot.Main(f.account)
    assert.ok(f.events.includes('card:punch:desktop'))
    assert.ok(f.events.includes('earn:desktop-search'))
    assert.equal(f.events.includes('earn:read'), false)
})

test('reading still runs last when ordinary searches are disabled', async () => {
    const f = fixture(modes[0]!)
    f.config.workers.doMobileSearch = false
    f.config.workers.doDesktopSearch = false
    f.config.workers.doBonusSearches = false
    await f.bot.Main(f.account)
    assert.deepEqual(
        f.events.filter(event => event.startsWith('earn:')),
        ['earn:read']
    )
    assert.ok(f.events.indexOf('cardscan:desktop') < f.events.indexOf('earn:read'))
})
