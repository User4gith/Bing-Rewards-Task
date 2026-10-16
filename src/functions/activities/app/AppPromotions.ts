import { BaseActivity } from '../BaseActivity'
import type { AppDashboardData } from '../../../interface/AppDashBoardData'

export class AppPromotions extends BaseActivity {
    public async run(data: AppDashboardData): Promise<void> {
        await this.bot.taskCoverage.scanApp(data)
        const pending = data.response.promotions.filter(promotion => {
            const attributes = promotion.attributes
            return (
                this.bot.taskCoverage.ledger.get(`app:${attributes['offerid']}`)?.status !== 'complete' &&
                Boolean(attributes['offerid']) &&
                attributes['type'] === 'sapphire'
            )
        })

        if (!pending.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                '本次列表中没有待执行的 sapphire 项目；其余类型以任务验收为准'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'APP-PROMOTIONS',
            `开始解决"应用推广"项目 | remaining=${pending.length}`
        )
        for (const [index, promotion] of pending.entries()) {
            await this.bot.activities.doAppReward(promotion)
            await this.bot.taskCoverage.scanApp()
            if (index < pending.length - 1) {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            }
        }
        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', '"应用推广"项目处理完毕')
    }
}
