import type { Config } from '../interface/Config'

/** Full coverage is explicit and has one effective configuration. No random partial targets. */
export function applyTaskCoverageConfig(config: Config): Config {
    if (config.taskCoverage?.enabled === false) return config
    return {
        ...config,
        taskCoverage: {
            enabled: true,
            maxPasses: config.taskCoverage?.maxPasses ?? 3,
            verificationAttempts: config.taskCoverage?.verificationAttempts ?? 3,
            timeZone: config.taskCoverage?.timeZone ?? 'Asia/Shanghai'
        },
        workers: {
            ...config.workers,
            doDailySet: true,
            doMorePromotions: true,
            doPunchCards: true,
            doDesktopSearch: true,
            doMobileSearch: true,
            doBonusSearches: true,
            doActivateSearchPerk: true,
            doClaimBonusPoints: true,
            doVisualSearch: true,
            doDailyCheckIn: true,
            doAppPromotions: true,
            doReadToEarn: true
        },
        activities: { ...config.activities, urlReward: true, searchOnBing: true },
        experimental: { ...config.experimental, edgeBrowsing: true },
        skipNonPointTasks: false,
        autoClaimPunchcardRewards: true,
        searchSettings: { ...config.searchSettings, parallelSearching: false, clickRandomResults: false },
        humanize: {
            ...config.humanize,
            skipWhenCompletedToday: false,
            searchTargetRatio: { min: 1, max: 1 },
            readToEarnArticles: { min: 10, max: 10 }
        }
    }
}
