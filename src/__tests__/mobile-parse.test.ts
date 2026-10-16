/**
 * 移动端账户数据解析单元测试
 * 
 * 测试 src/browser/ReactFunc.ts 中的移动端 HTML 回退解析逻辑：
 * - extractMobilePointsFromHtml
 * - extractMobileLevelFromHtml
 * 
 * 运行：npx ts-node src/__tests__/mobile-parse.test.ts
 * 或：node dist/__tests__/mobile-parse.test.js
 */

// 与 ReactFunc.ts 中的实现保持一致（复制用于独立测试）
function extractMobilePointsFromHtml(html: string): number | null {
    try {
        const headerRe =
            /<p[^>]*>\s*([\d,]+)\s*<\/p>\s*<img[^>]*alt="([^"]*(?:银牌会员|金牌会员|Silver Member|Gold Member)[^"]*)"/i
        const hm = headerRe.exec(html)
        if (hm) {
            const value = parseInt(hm[1]!.replace(/,/g, ''), 10)
            if (Number.isFinite(value)) return value
        }
        const pRe = /<p[^>]*>\s*([\d,]+)\s*<\/p>/gi
        const levelRe = /银牌会员|金牌会员|Silver Member|Gold Member/i
        let m: RegExpExecArray | null
        while ((m = pRe.exec(html)) !== null) {
            const pos = m.index ?? 0
            const window = html.substring(Math.max(0, pos - 500), pos + 500)
            if (levelRe.test(window)) {
                const value = parseInt(m[1]!.replace(/,/g, ''), 10)
                if (Number.isFinite(value)) return value
            }
        }
        return null
    } catch {
        return null
    }
}

function extractMobileLevelFromHtml(html: string): number | null {
    try {
        const headerRe = /<p[^>]*>\s*[\d,]+\s*<\/p>\s*<img[^>]*alt="([^"]*)"/i
        const hm = headerRe.exec(html)
        if (hm) {
            const alt = hm[1] ?? ''
            if (/金牌|Gold/i.test(alt)) return 2
            if (/银牌|Silver/i.test(alt)) return 1
        }
        const firstGold = html.search(/金牌会员|Gold Member/i)
        const firstSilver = html.search(/银牌会员|Silver Member/i)
        if (firstGold >= 0 && (firstSilver < 0 || firstGold < firstSilver)) return 2
        if (firstSilver >= 0) return 1
        return null
    } catch {
        return null
    }
}

interface TestCase {
    name: string
    html: string
    expectedPoints: number | null
    expectedLevel: number | null
}

const testCases: TestCase[] = [
    // 正常情况
    { name: '正常银牌', html: '<div><p>1,225</p><img alt="银牌会员"></div>', expectedPoints: 1225, expectedLevel: 1 },
    { name: '正常金牌', html: '<div><p>5,000</p><img alt="金牌会员"></div>', expectedPoints: 5000, expectedLevel: 2 },
    { name: '英文银牌', html: '<div><p>999</p><img alt="Silver Member"></div>', expectedPoints: 999, expectedLevel: 1 },
    { name: '英文金牌', html: '<div><p>10,000</p><img alt="Gold Member"></div>', expectedPoints: 10000, expectedLevel: 2 },
    
    // 边界情况
    { name: '0分边界', html: '<div><p>0</p><img alt="银牌会员"></div>', expectedPoints: 0, expectedLevel: 1 },
    { name: '千位分隔符', html: '<div><p>12,345</p><img alt="银牌会员"></div>', expectedPoints: 12345, expectedLevel: 1 },
    { name: '大额积分', html: '<div><p>1,234,567</p><img alt="金牌会员"></div>', expectedPoints: 1234567, expectedLevel: 2 },
    
    // 抗误识别
    { name: '活动奖励无会员标识', html: '<div><p>50</p><span>完成任务+50</span></div>', expectedPoints: null, expectedLevel: null },
    { name: '任务进度数字', html: '<div><p>30</p><p>100</p></div><span>每日任务</span>', expectedPoints: null, expectedLevel: null },
    
    // 缺失数据
    { name: '无会员等级', html: '<div><p>1,225</p></div>', expectedPoints: null, expectedLevel: null },
    { name: '空页面', html: '<html><body></body></html>', expectedPoints: null, expectedLevel: null },
    { name: '有等级无积分', html: '<div><span>银牌会员</span></div>', expectedPoints: null, expectedLevel: 1 },
    
    // 真实页面结构（2026-10-16 实际捕获）
    {
        name: '真实移动端结构',
        html: '<div class="flex items-center gap-2"><p>1,225</p><img alt="银牌会员" fetchpriority="high" decoding="async" loading="lazy"></div>',
        expectedPoints: 1225,
        expectedLevel: 1
    },
    // 混合场景：头部是银牌，页面其他位置有金牌推广文案
    {
        name: '银牌头部+金牌推广文案',
        html: '<div><p>1,225</p><img alt="银牌会员"></div><div>升级到金牌会员享受更多权益</div>',
        expectedPoints: 1225,
        expectedLevel: 1
    },
]

let passed = 0
let failed = 0

console.log('=== 移动端解析单元测试 ===\n')

for (const tc of testCases) {
    const points = extractMobilePointsFromHtml(tc.html)
    const level = extractMobileLevelFromHtml(tc.html)
    const pointsOk = points === tc.expectedPoints
    const levelOk = level === tc.expectedLevel
    const ok = pointsOk && levelOk
    
    if (ok) {
        passed++
        console.log(`✓ ${tc.name}`)
    } else {
        failed++
        console.log(`✗ ${tc.name}`)
        console.log(`  积分: 得到 ${points}, 期望 ${tc.expectedPoints}`)
        console.log(`  等级: 得到 ${level}, 期望 ${tc.expectedLevel}`)
    }
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败, 共 ${testCases.length} 项 ===`)

// 关键断言（退出码）
const critical = [
    extractMobilePointsFromHtml('<div><p>0</p><img alt="银牌会员"></div>') === 0,
    extractMobilePointsFromHtml('<div><p>50</p><span>任务</span></div>') === null,
]
if (failed > 0 || !critical.every(Boolean)) {
    console.log('\n测试失败')
    process.exit(1)
} else {
    console.log('\n所有测试通过')
    process.exit(0)
}
