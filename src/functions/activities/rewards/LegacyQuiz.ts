import { BaseActivity } from '../BaseActivity'
import type { BasePromotion } from '../../../interface/DashboardData'
import { findPromotion, promotionComplete } from './TaskDiscovery'

/** Legacy quiz/poll activity protocol retained by upstream v3.
 * Stop on task progress stagnation; a 200 response or account balance gain is not completion. */
export class LegacyQuiz extends BaseActivity {
    async run(promotion: BasePromotion): Promise<void> {
        const url = 'https://www.bing.com/bingqa/ReportActivity?ajaxreq=1'
        let previous = Number(promotion.pointProgress) || 0
        for (let attempt = 0; attempt < 20; attempt++) {
            const cookies = this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop
            await this.bot.http.request({
                url,
                method: 'POST',
                retries: 0,
                headers: {
                    ...this.bot.fingerprint.headers,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    Cookie: this.bot.browser.func.buildCookieHeader(cookies, ['bing.com']),
                    Referer: 'https://www.bing.com/'
                },
                data: JSON.stringify({
                    UserId: null,
                    timeZone: this.bot.userData.timezoneOffset,
                    OfferId: promotion.offerId,
                    ActivityCount: 1,
                    QuestionIndex: '-1'
                })
            })
            await this.bot.utils.wait(2000)
            const data = await this.bot.browser.func.getDashboardData()
            const current = findPromotion(data.dashboard, promotion.offerId)
            if (current && promotionComplete(current)) return
            const progress = Number(current?.pointProgress)
            if (!Number.isFinite(progress) || progress <= previous) break
            previous = progress
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))
        }
    }
}
