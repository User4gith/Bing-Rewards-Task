import { BaseActivity } from '../BaseActivity'
import type { BasePromotion } from '../../../interface/DashboardData'
import { URLs } from '../../../constants/urls'

export function safeCardDestination(value: string): string | null {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
        const url = new URL(value, URLs.rewards.origin)
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            !/(^|\.)(bing\.com|microsoft\.com)$/i.test(url.hostname) ||
            /logout|signout|delete|redeem|donat|checkout|payment|purchase|billing/i.test(url.pathname)
        )
            return null
        return url.href
    } catch {
        return null
    }
}

/** Visit a visible card through the signed-in browser when it has no server-action metadata. */
export class BrowserCard extends BaseActivity {
    async run(promotion: BasePromotion): Promise<void> {
        const destination = safeCardDestination(promotion.destinationUrl)
        if (!destination) throw new Error('卡片需要外部网站、兑换/购买操作或缺少有效地址，需要人工处理')
        const main = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        if (!main || main.isClosed()) throw new Error('卡片访问需要可用浏览器会话')
        const page = await main.context().newPage()
        let popup: import('patchright').Page | null = null
        try {
            await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            const links = page.locator('a[href]')
            const index = await links.evaluateAll((nodes, destination) => {
                const canonical = (value: string): string => {
                    const url = new URL(value, location.href)
                    for (const key of [...url.searchParams.keys()])
                        if (/^(form|ocid|cvid|pc|mkt|cc|setlang)$/i.test(key)) url.searchParams.delete(key)
                    url.searchParams.sort()
                    url.hash = ''
                    return url.href
                }
                return nodes.findIndex(node => canonical((node as HTMLAnchorElement).href) === canonical(destination))
            }, destination)
            if (index >= 0) {
                const opened = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null)
                await links.nth(index).click({ timeout: 10_000 })
                popup = await opened
            } else await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
            await this.bot.browser.func.synchronizeActiveBrowserCookies('CARD-VISIT')
        } finally {
            if (popup) await popup.close().catch(() => {})
            await page.close().catch(() => {})
        }
    }
}
