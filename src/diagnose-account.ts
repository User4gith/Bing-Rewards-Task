/**
 * Read-only 账户诊断入口
 * 
 * 用途：验证移动端账户数据解析，不触发自动搜索、活动领取或积分上报。
 * 使用现有合法登录会话，只读取页面数据。
 * 
 * 运行：node dist/diagnose-account.js
 * 
 * 输出（脱敏）：只包含积分数字、等级、布尔状态，不包含 Cookie/Token/密码。
 */
import { chromium } from 'patchright'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

const PROJECT_ROOT = '/home/hatch/workspace/ms-rewards-script'
const SESSION_DB = path.join(PROJECT_ROOT, 'sessions', 'sessions.db')
const EMAIL = 'yang4bing1@icloud.com'
const PROXY = 'http://127.0.0.1:3129'

interface DiagnoseResult {
    pageLoaded: boolean
    finalUrl: string
    sessionValid: boolean
    availablePoints: number | null
    level: number | null
    htmlPointsMatch: boolean
    domPoints: string | null
    checks: {
        pageLoad: boolean
        auth: boolean
        dataReady: boolean
    }
}

// 与 ReactFunc.ts 中的移动端回退解析保持一致
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

async function diagnose(): Promise<DiagnoseResult> {
    const result: DiagnoseResult = {
        pageLoaded: false,
        finalUrl: '',
        sessionValid: false,
        availablePoints: null,
        level: null,
        htmlPointsMatch: false,
        domPoints: null,
        checks: { pageLoad: false, auth: false, dataReady: false }
    }

    let browser = null
    try {
        const db = new DatabaseSync(SESSION_DB)
        const row = db
            .prepare('SELECT storage_state FROM sessions WHERE email = ? AND platform = ?')
            .get(EMAIL, 'mobile') as { storage_state: string } | undefined
        db.close()

        if (!row) {
            console.log('错误：未找到移动端会话')
            return result
        }

        const storageState = JSON.parse(row.storage_state)
        browser = await chromium.launch({ headless: true, proxy: { server: PROXY } })
        const context = await browser.newContext({
            storageState,
            // 与主程序 config.json proxy.ignoreCertificateErrors=true 一致：
            // 本地 MITM 代理 (127.0.0.1:3129) 使用自签 CA，需信任代理证书
            ignoreHTTPSErrors: true,
            userAgent:
                'Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36 EdgA/155.0.4283.48',
            viewport: { width: 412, height: 915 },
            isMobile: true,
            hasTouch: true,
            locale: 'zh-CN'
        })
        const page = await context.newPage()

        // 1. 页面加载检查
        console.log('[1/5] 正在加载 https://rewards.bing.com/earn ...')
        const resp = await page.goto('https://rewards.bing.com/earn', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        })
        await page.waitForTimeout(8000)

        result.finalUrl = page.url()
        result.pageLoaded = resp !== null && resp.ok()
        result.checks.pageLoad = result.pageLoaded
        console.log(`     页面加载: ${result.pageLoaded ? '成功' : '失败'} (HTTP ${resp?.status() ?? 'N/A'})`)
        console.log(`     最终URL: ${result.finalUrl}`)

        // 2. 会话有效性检查（未跳转到登录页）
        const url = page.url()
        const isLoginRedirect =
            url.includes('login.live.com') || url.includes('login.microsoftonline.com')
        const isAboutPage = url.includes('/about')
        result.sessionValid = !isLoginRedirect && !isAboutPage && result.pageLoaded
        result.checks.auth = result.sessionValid
        console.log(`     会话有效: ${result.sessionValid ? '是' : '否'}`)

        if (!result.sessionValid) {
            console.log('会话无效，停止诊断')
            return result
        }

        // 3. DOM 直接读取积分（页面显示值）
        result.domPoints = await page.evaluate(() => {
            const els = document.querySelectorAll('p')
            for (const el of els) {
                const t = (el.textContent ?? '').trim()
                if (/^[\d,]+$/.test(t) && t.length >= 2 && t.length <= 7) {
                    // 检查附近是否有会员标识
                    const parent = el.parentElement
                    if (parent && /银牌会员|金牌会员|Silver Member|Gold Member/i.test(parent.innerHTML)) {
                        return t
                    }
                }
            }
            return null
        })
        console.log(`     DOM显示积分: ${result.domPoints ?? '未找到'}`)

        // 4. HTML 解析（使用与 ReactFunc.ts 相同的逻辑）
        const html = await page.content()
        result.availablePoints = extractMobilePointsFromHtml(html)
        result.level = extractMobileLevelFromHtml(html)
        console.log(`     HTML解析积分: ${result.availablePoints ?? 'null'}`)
        console.log(`     HTML解析等级: ${result.level ?? 'null'}`)

        // 5. 一致性检查
        if (result.domPoints !== null && result.availablePoints !== null) {
            const domNum = parseInt(result.domPoints.replace(/,/g, ''), 10)
            result.htmlPointsMatch = domNum === result.availablePoints
            console.log(`     解析一致性: ${result.htmlPointsMatch ? '一致' : '不一致'}`)
        }

        result.checks.dataReady =
            result.availablePoints !== null && result.level !== null
        console.log(`\n三项检查: 页面加载=${result.checks.pageLoad ? '通过' : '失败'}, 账户认证=${result.checks.auth ? '通过' : '失败'}, 数据就绪=${result.checks.dataReady ? '通过' : '失败'}`)
    } catch (e) {
        console.log(`诊断异常: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
        if (browser) await browser.close()
    }

    return result
}

// 直接运行时的入口
if (require.main === module) {
    diagnose().then(r => {
        console.log('\n=== 诊断完成 ===')
        // 脱敏输出：只打印数字和布尔值
        console.log(JSON.stringify({
            pageLoaded: r.pageLoaded,
            sessionValid: r.sessionValid,
            availablePoints: r.availablePoints,
            level: r.level,
            htmlPointsMatch: r.htmlPointsMatch,
            checks: r.checks
        }, null, 2))
        process.exit(r.checks.pageLoad && r.checks.auth && r.checks.dataReady ? 0 : 1)
    })
}

export { diagnose, extractMobilePointsFromHtml, extractMobileLevelFromHtml }
