import { BaseActivity } from '../BaseActivity'
import type { DashboardData } from '../../../interface/DashboardData'

export class MorePromotions extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        // Includes daily activities, promotionalItems, high-value actions and page-only offers.
        await this.bot.taskCoverage.run('more', data, { cardsOnly: true })
    }
}
