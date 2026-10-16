import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireRunLock } from '../util/RunLock'

test('a live runner cannot be started twice and releases its own lock', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-lock-'))
    const filename = path.join(directory, 'run.lock')
    try {
        const release = acquireRunLock(filename)
        assert.throws(() => acquireRunLock(filename), /拒绝重复启动/)
        release()
        assert.equal(fs.existsSync(filename), false)
        acquireRunLock(filename)()
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('a stale process lock is recoverable and another owner cannot be deleted', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-lock-'))
    const filename = path.join(directory, 'run.lock')
    try {
        fs.writeFileSync(filename, JSON.stringify({ pid: 2147483647, owner: 'stale' }))
        const release = acquireRunLock(filename)
        fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, owner: 'other' }))
        release()
        assert.equal(fs.existsSync(filename), true)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
