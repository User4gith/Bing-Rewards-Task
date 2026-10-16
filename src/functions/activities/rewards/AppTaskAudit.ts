import type { AppDashboardData } from '../../../interface/AppDashBoardData'
import type { TaskLedger, TaskStatus } from './TaskLedger'
import { taskDate } from './TaskDiscovery'

export function observeAppTasks(data: AppDashboardData, ledger: TaskLedger, offset: string): void {
    for (const promotion of data.response.promotions ?? []) {
        const attrs = promotion.attributes
        const id = attrs.offerid
        if (!id) continue
        const type = (attrs.type ?? '').toLowerCase()
        const max = Number(attrs.pointmax ?? '0')
        const progress = Number(attrs.pointprogress ?? '0')
        if (max <= 0 && !['sapphire', 'checkin', 'msnreadearn'].includes(type)) continue
        let complete = String(attrs.complete).toLowerCase() === 'true' || (max > 0 && progress >= max)
        if (type === 'checkin') {
            const updated = Date.parse(attrs.last_updated ?? '')
            complete = Number.isFinite(updated) && taskDate(offset, updated) === taskDate(offset)
        }
        const knownType = ['sapphire', 'checkin', 'msnreadearn'].includes(type)
        const status: TaskStatus = complete ? 'complete' : knownType ? 'pending' : 'unsupported'
        ledger.set(`app:${id}`, {
            category: 'app',
            title: attrs.title ?? id,
            sources: ['app'],
            pointsMax: Number.isFinite(max) ? max : 0,
            pointsEarned: Number.isFinite(progress) ? progress : null,
            status,
            reason: complete
                ? 'App 官网任务进度已完成'
                : knownType
                  ? 'App 任务仍有未完成进度'
                  : `未支持的 App 活动类型 ${type}`
        })
    }
}
