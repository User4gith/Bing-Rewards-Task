import test from 'node:test'
import assert from 'node:assert/strict'
import ReactFunc from '../browser/ReactFunc'
import type { MicrosoftRewardsBot } from '../index'

const bot = {
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    isMobile: true
} as unknown as MicrosoftRewardsBot
const parser = new ReactFunc(bot)
const flight = (value: unknown): string =>
    `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(value))}])</script>`

for (const [label, points, level] of [
    ['银牌会员', '1,225', 1],
    ['金牌会员', '5,000', 2],
    ['Silver Member', '999', 1],
    ['Gold Member', '10,000', 2],
    ['银牌会员', '0', 1],
    ['金牌会员', '1,234,567', 2]
] as const) {
    test(`production snapshot parses ${label} ${points}`, () => {
        const result = parser.snapshotPage(`<div><p>${points}</p><img alt="${label}"></div>`)
        assert.equal(result.account.availablePoints, Number(points.replaceAll(',', '')))
        assert.equal(result.account.level, level)
    })
}

test('HTML account fallback is connected even when membership Flight exists', () => {
    const result = parser.snapshotPage(
        '<div><p>1,225</p><img alt="银牌会员"></div>' + flight({ level: 1, pointsProgress: 0, pointsRemaining: 0 })
    )
    assert.equal(result.account.availablePoints, 1225)
})

test('upgrade advertising and card numbers are never account balance or membership', () => {
    for (const html of [
        '<div><p>50</p><span>升级到金牌会员享受更多权益</span></div>',
        '<div><p>30</p><p>100</p></div>',
        '<p>50</p><img alt="升级到金牌会员">'
    ]) {
        const result = parser.snapshotPage(html)
        assert.equal(result.account.availablePoints, null)
        assert.equal(result.account.level, null)
    }
})

test('payload balance takes priority over HTML fallback', () => {
    const result = parser.snapshotPage(
        '<p>999</p><img alt="金牌会员">' +
            flight({ availablePoints: 123, level: 1, pointsProgress: 1, pointsRemaining: 3 })
    )
    assert.equal(result.account.availablePoints, 123)
    assert.equal(result.account.level, 1)
})

test('page offers preserve backend type, reject invalid hashes and recognise point progress', () => {
    const result = parser.snapshotPage(
        flight([
            { offerId: 'quiz', promotionType: 'quiz', hash: 'signed', points: 10 },
            { offerId: 'nohash', hash: '$undefined', points: 10 },
            { offerId: 'done', hash: 'signed', pointProgressMax: 10, pointProgress: 10 },
            { offerId: 'disabled', hash: 'signed', isDisabled: true }
        ])
    )
    assert.equal(result.offers.find(o => o.offerId === 'quiz')?.promotionType, 'quiz')
    assert.equal(result.offers.find(o => o.offerId === 'nohash')?.reportable, false)
    assert.equal(result.offers.find(o => o.offerId === 'done')?.isCompleted, true)
    assert.equal(result.offers.find(o => o.offerId === 'disabled')?.reportable, false)
})

test('quest child IDs need not contain pcchild and keep their activity type', () => {
    const result = parser.snapshotQuestPage(
        flight({ offerId: 'new_child_format', hash: 'signed', activityType: 714, isCompleted: false })
    )
    assert.equal(result[0]?.offerId, 'new_child_format')
    assert.equal(result[0]?.activityType, 714)
})

test('visible scored cards survive missing Flight metadata and are deduplicated by destination', () => {
    const html = '<a href="https://www.bing.com/search?q=weather&amp;form=ABC" data-offer-id="visible">天气 +10积分</a>'
    assert.equal(parser.snapshotPage(html).offers[0]?.offerId, 'visible')
    const same = flight({
        offerId: 'json-id',
        hash: 'signed',
        points: 10,
        destination: 'https://www.bing.com/search?q=weather'
    })
    assert.equal(parser.snapshotPage(html + same).offers.length, 1)
    assert.equal(parser.snapshotPage('<a href="/redeem">1,225 积分</a>').offers.length, 0)
})

test('page snapshot preserves absent versus explicitly empty search quota fields', () => {
    const result = parser.snapshotPage(
        flight({ counters: { pcSearch: [], MobileSearch: [{ pointProgress: 3, pointProgressMax: 30 }] } })
    )
    assert.deepEqual(result.searchCounters?.pcSearch, [])
    assert.equal(result.searchCounters?.mobileSearch?.[0]?.pointProgressMax, 30)
    assert.equal(parser.snapshotPage('<html></html>').searchCounters?.pcSearch, undefined)
})
