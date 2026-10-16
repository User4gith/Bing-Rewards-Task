import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** One primary runner per checkout. Workers share their primary's lock. */
export function acquireRunLock(filename: string): () => void {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    const owner = randomUUID()
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(filename, 'wx', 0o600)
            try {
                fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() }))
            } finally {
                fs.closeSync(fd)
            }
            return () => {
                try {
                    if (JSON.parse(fs.readFileSync(filename, 'utf8')).owner === owner) fs.unlinkSync(filename)
                } catch {}
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            let pid: number | undefined
            try {
                pid = JSON.parse(fs.readFileSync(filename, 'utf8')).pid
            } catch {}
            if (Number.isInteger(pid) && pid! > 0) {
                try {
                    process.kill(pid!, 0)
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                        fs.unlinkSync(filename)
                        continue
                    }
                }
                throw new Error(`已有脚本主进程运行（PID=${pid}），拒绝重复启动`)
            }
            throw new Error('运行锁正在初始化或格式无效，拒绝并发启动')
        }
    }
    throw new Error('未能取得脚本运行锁')
}
