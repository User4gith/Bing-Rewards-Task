import { BaseActivity } from '../BaseActivity'
import type { DashboardData } from '../../../interface/DashboardData'

export class DailySet extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        await this.bot.taskCoverage.run('dailySet', data, { cardsOnly: true })
    }
}
