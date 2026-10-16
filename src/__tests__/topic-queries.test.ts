import test from 'node:test'
import assert from 'node:assert/strict'
import type { MicrosoftRewardsBot } from '../index'
import type { BasePromotion } from '../interface/DashboardData'
import Util from '../util/Utils'
import library from '../functions/bing-search-activity-queries.json'
import { getSearchOnBingQueries } from '../functions/activities/search/SearchOnBingShared'

function fixture(options: { localOnly?: boolean; payload?: unknown; error?: Error } = {}) {
    let calls = 0
    const messages: string[] = []
    const bot = {
        isMobile: true,
        config: { searchOnBingLocalQueries: options.localOnly ?? false },
        utils: new Util(),
        logger: Object.fromEntries(
            ['debug', 'info', 'warn', 'error'].map(level => [
                level,
                (...args: unknown[]) => messages.push(String(args[2]))
            ])
        ),
        http: {
            request: async () => {
                calls++
                if (options.error) throw options.error
                return { data: options.payload }
            }
        }
    } as unknown as MicrosoftRewardsBot
    return {
        bot,
        messages,
        get calls() {
            return calls
        }
    }
}

function promotion(title: string, description = ''): BasePromotion {
    return { title, description } as BasePromotion
}

function titleKey(value: string): string {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, '')
}

test('bundled topics have substantial, distinct queries and unambiguous titles and aliases', () => {
    const titles = new Set<string>()
    assert.ok(library.length >= 69)
    assert.ok(library.reduce((total, topic) => total + topic.queries.length, 0) >= 2000)
    for (const topic of library) {
        assert.ok(topic.queries.length >= 25, topic.title)
        const queries = new Set<string>()
        for (const query of topic.queries) {
            assert.equal(query, query.trim().replace(/\s+/g, ' '), topic.title)
            assert.ok(query.length > 0)
            const key = query.normalize('NFKC').toLowerCase()
            assert.equal(queries.has(key), false, `${topic.title}: ${query}`)
            assert.doesNotMatch(query, /\b(?:city x|city y|insert word|song name|fojfksikjlzksdf)\b/i)
            queries.add(key)
        }
        for (const title of [topic.title, ...topic.aliases]) {
            const key = titleKey(title)
            assert.ok(key)
            assert.equal(titles.has(key), false, `ambiguous title: ${title}`)
            titles.add(key)
        }
    }
})

test('every bundled title and alias reaches the production query loader with remote-enabled defaults', async () => {
    const f = fixture({ error: new Error('network must not be needed for bundled themes') })
    for (const topic of library) {
        for (const title of [topic.title, ...topic.aliases]) {
            const queries = await getSearchOnBingQueries(f.bot, promotion(title))
            assert.deepEqual(new Set(queries), new Set(topic.queries), title)
        }
    }
    assert.equal(f.calls, 0)
    assert.ok(f.messages.some(message => message.includes('本地增强词库')))
})

test('all four screenshot topics use expanded curated queries rather than title fallbacks', async () => {
    const f = fixture()
    for (const title of ['Know your score', 'Feeling symptoms?', 'Learn a new recipe', 'Explore videogames']) {
        const queries = await getSearchOnBingQueries(f.bot, promotion(title, 'Search on Bing for new recipes'))
        assert.ok(queries.length >= 40, title)
        assert.equal(queries.includes(title), false)
        assert.equal(queries.includes('new recipes'), false)
    }
    assert.equal(f.calls, 0)
})

test('legacy titles, changed punctuation, capitalisation and Chinese aliases keep their intended themes', async () => {
    const f = fixture({ localOnly: true })
    const pairs = [
        ['Learn a new recipe', 'Learn to cook a new recipe'],
        ['Learn a new recipe', 'LEARN A NEW RECIPE!!!'],
        ['Learn a new recipe', '学习新食谱'],
        ["How's the economy?", 'How’s the economy?'],
        ['Explore videogames', 'Gaming time'],
        ['Find places to stay', 'Find places to stay!'],
        ['Take off soon', 'Perfect flight'],
        ['Prepare for the weather', 'Prepare for weather']
    ]
    for (const [canonical, alias] of pairs) {
        const expected = await getSearchOnBingQueries(f.bot, promotion(canonical!))
        const actual = await getSearchOnBingQueries(f.bot, promotion(alias!))
        assert.deepEqual(new Set(actual), new Set(expected), alias)
    }
})

test('new themes are available through the same production entry without creating or executing tasks', async () => {
    const f = fixture()
    for (const title of [
        'Discover technology',
        'Explore space',
        'Get moving',
        'Grow your garden',
        'Learn a language',
        'Plan your commute',
        'Convert a measurement',
        'Do the maths',
        'Explore science',
        'Travel by train',
        'Find a podcast',
        'Visit a museum',
        'Explore history',
        'Take better photos',
        'Save energy at home',
        'Learn to code',
        'Discover wildlife',
        'Plan a hiking trip',
        'Explore art',
        'Try a new hobby'
    ]) {
        const queries = await getSearchOnBingQueries(f.bot, promotion(title))
        assert.ok(queries.length >= 25, title)
    }
    assert.equal(f.calls, 0)
})

test('an unknown local theme can use valid remote aliases and deduplicate malformed mixed entries', async () => {
    const f = fixture({
        payload: [
            null,
            { title: 42, queries: ['wrong'] },
            { title: 'Unrelated remote topic', queries: ['wrong theme'] },
            {
                title: 'New remote theme',
                aliases: ['A remote-only activity'],
                queries: [' first query ', 'FIRST QUERY', '', 5, null, 'second query']
            },
            { title: 'A remote-only activity', queries: ['second query', 'third query'] }
        ]
    })
    const queries = await getSearchOnBingQueries(f.bot, promotion('A remote-only activity!'))
    assert.deepEqual(
        new Set(queries.map(query => query.toLowerCase())),
        new Set(['first query', 'second query', 'third query'])
    )
    assert.equal(f.calls, 1)
    assert.ok(f.messages.some(message => message.includes('远程补充词库')))
})

test('local-only mode preserves an unknown theme as a description fallback without fetching remotely', async () => {
    const f = fixture({ localOnly: true, error: new Error('must not fetch') })
    const queries = await getSearchOnBingQueries(
        f.bot,
        promotion('A new local-only theme', 'Search on Bing for local geology')
    )
    assert.ok(queries.includes('local geology'))
    assert.equal(f.calls, 0)
})

test('an unknown Chinese title never matches a different theme after Unicode normalisation', async () => {
    const f = fixture({ localOnly: true })
    const queries = await getSearchOnBingQueries(f.bot, promotion('完全未知主题', 'Search on Bing for local geology'))
    assert.deepEqual(new Set(queries), new Set(['local geology', '完全未知主题', 'Search on Bing for local geology']))
})

for (const payload of [{ error: 'temporarily unavailable' }, '<html>error</html>', null]) {
    test(`invalid remote payload ${JSON.stringify(payload)} falls back without losing the activity`, async () => {
        const f = fixture({ payload })
        const queries = await getSearchOnBingQueries(
            f.bot,
            promotion('New unmapped theme', 'Search on Bing for local geology')
        )
        assert.ok(queries.includes('local geology'))
        assert.equal(f.calls, 1)
    })
}

test('remote transport failures retain the description fallback for a genuinely unknown theme', async () => {
    const f = fixture({ error: new Error('timeout') })
    const queries = await getSearchOnBingQueries(
        f.bot,
        promotion('New unmapped theme', 'Search on Bing for local geology')
    )
    assert.ok(queries.includes('local geology'))
    assert.ok(f.messages.some(message => message.includes('远程主题词库不可用')))
})
