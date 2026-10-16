import fs from 'node:fs'
import path from 'node:path'
import type { DiscoveredTask } from './TaskDiscovery'
import { isLockedPromotion, promotionComplete } from './TaskDiscovery'
import { getProjectRoot } from '../../../util/ConfigSync'

export type TaskStatus =
    | 'pending'
    | 'complete'
    | 'failed'
    | 'blocked'
    | 'deferred'
    | 'unsupported'
    | 'unverified'
    | 'disabled'
    | 'unavailable'

export interface TaskRecord {
    id: string
    title: string
    category: string
    sources: string[]
    pointsMax: number
    pointsEarned: number | null
    status: TaskStatus
    reason: string
    attempts: number
    updatedAt: string
}

const UNRESOLVED = new Set<TaskStatus>(['pending', 'failed', 'unsupported', 'unverified', 'disabled'])

/** Only server task state can complete a task. Aggregate balance gains are never proof. */
export class TaskLedger {
    private readonly records = new Map<string, TaskRecord>()

    reset(): void {
        this.records.clear()
    }

    observe(task: DiscoveredTask, today: string): TaskRecord {
        const p = task.promotion
        const existing = this.records.get(p.offerId)
        const status: TaskStatus = promotionComplete(p)
            ? 'complete'
            : isLockedPromotion(p)
              ? 'blocked'
              : task.date && task.date > today
                ? 'deferred'
                : existing?.status === 'complete'
                  ? 'unverified'
                  : existing?.status === 'deferred' && existing.reason.startsWith('多天')
                    ? 'deferred'
                    : existing && !['blocked', 'deferred', 'unavailable'].includes(existing.status)
                      ? existing.status
                      : 'pending'
        return this.set(p.offerId, {
            title: p.title || p.offerId,
            category: task.category,
            sources: [...new Set([...(existing?.sources ?? []), ...task.sources])],
            pointsMax: Math.max(0, Number(p.pointProgressMax) || 0),
            pointsEarned: Number.isFinite(Number(p.pointProgress)) ? Number(p.pointProgress) : null,
            status,
            reason:
                status === 'complete'
                    ? '官网任务状态已完成'
                    : status === 'blocked'
                      ? '官网标记锁定或禁用'
                      : status === 'deferred'
                        ? `尚未到任务日期 ${task.date}`
                        : (existing?.reason ?? '等待执行和核验')
        })
    }

    set(id: string, update: Partial<Omit<TaskRecord, 'id'>>): TaskRecord {
        const previous = this.records.get(id)
        const record: TaskRecord = {
            id,
            title: id,
            category: 'other',
            sources: [],
            pointsMax: 0,
            pointsEarned: null,
            status: 'pending',
            reason: '',
            attempts: 0,
            ...previous,
            ...update,
            updatedAt: new Date().toISOString()
        }
        this.records.set(id, record)
        return record
    }

    attempt(id: string): void {
        this.set(id, { attempts: (this.records.get(id)?.attempts ?? 0) + 1, status: 'pending', reason: '执行中' })
    }

    get(id: string): TaskRecord | undefined {
        return this.records.get(id)
    }
    list(): TaskRecord[] {
        return [...this.records.values()]
    }
    unresolved(): TaskRecord[] {
        return this.list().filter(task => UNRESOLVED.has(task.status))
    }
    summary(): { complete: boolean; total: number; verified: number; unresolved: number; excluded: number } {
        const list = this.list()
        const unresolved = this.unresolved().length
        const verified = list.filter(task => task.status === 'complete').length
        return {
            complete: list.length > 0 && unresolved === 0,
            total: list.length,
            verified,
            unresolved,
            excluded: list.length - verified - unresolved
        }
    }

    save(accountEmail: string): string {
        const directory = path.join(getProjectRoot(), 'logs', 'task-reports')
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        const name = accountEmail.replace(/[^a-zA-Z0-9@._-]/g, '_')
        const target = path.join(directory, `${name}-latest.json`)
        const temp = `${target}.${process.pid}.tmp`
        // Reports intentionally contain no cookies, credentials, hashes or action payloads.
        fs.writeFileSync(
            temp,
            JSON.stringify(
                {
                    account: accountEmail,
                    generatedAt: new Date().toISOString(),
                    summary: this.summary(),
                    tasks: this.list()
                },
                null,
                2
            ) + '\n',
            { mode: 0o600 }
        )
        fs.renameSync(temp, target)
        return target
    }
}
