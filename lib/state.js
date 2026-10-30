/**
 * 持久状态：设置、最近一次检查结果、任务记录（jobs）、日志。
 *
 * 所有写入都是 tmp + rename 的原子替换，避免宿主在更新中途被杀时留下半截 JSON；
 * 状态目录固定为 `<DSH_HOME>/auto-update`，与 DSH 自身的数据目录同级，
 * 因此升级 / 回滚都不会碰到它（这正是"回滚后还记得发生过什么"的前提）。
 * @module dsh-auto-update/state
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resolveLayout } from './paths.js'

/** 状态文件版本；结构变化时递增并在 loadState() 里迁移。 */
export const STATE_VERSION = 1

/**
 * @typedef {object} Settings
 * @property {boolean} autoCheck   打开网页时自动检查
 * @property {'auto' | 'latest' | 'next' | 'alpha' | 'newest'} channel 更新通道
 * @property {number} checkIntervalHours 最小检查间隔（小时）
 * @property {string} registry
 * @property {'full' | 'metadata'} backupMode 备份模式
 * @property {number} keepBackups 保留几份备份
 * @property {boolean} autoRollback 健康检查失败时自动回滚
 * @property {boolean} syncPlugins 更新后自动同步升级本地插件
 * @property {number} healthTimeoutSeconds
 * @property {number} dismissUntil 弹窗稍后提醒的时间戳（0 表示不推迟）
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  autoCheck: true,
  channel: 'auto',
  checkIntervalHours: 6,
  registry: 'https://registry.npmjs.org',
  backupMode: 'full',
  keepBackups: 2,
  autoRollback: true,
  syncPlugins: true,
  healthTimeoutSeconds: 90,
  dismissUntil: 0,
}

/**
 * @typedef {object} JobStep
 * @property {string} key
 * @property {'pending' | 'running' | 'ok' | 'failed' | 'skipped'} status
 * @property {string} [message]
 * @property {number} startedAt
 * @property {number} [endedAt]
 */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {'update' | 'rollback' | 'sync-plugins' | 'check' | 'preflight'} kind
 * @property {'running' | 'succeeded' | 'failed' | 'rolled-back' | 'cancelled'} status
 * @property {string | null} fromVersion
 * @property {string | null} toVersion
 * @property {string} phase
 * @property {JobStep[]} steps
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {string | null} error
 * @property {string | null} backupId
 * @property {string} logPath
 * @property {object | null} pluginReport
 * @property {{restarted: boolean, url: string | null, healthChecked: boolean, healthMs: number | null}} host
 */

/** 确保状态目录存在（失败不抛：只读环境下仍要能读状态、能给出原因）。 */
function ensureDirs(layout) {
  for (const dir of [layout.stateDir, layout.jobsDir, layout.backupsDir, layout.logsDir]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch {
      // 交给调用方按"读得到多少算多少"处理
    }
  }
}

/**
 * 原子写 JSON。
 * @param {string} path
 * @param {unknown} value
 */
export function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  // Windows 上 rename 可能因为目标正被别的进程读（或杀软在扫）而短暂失败：
  // 看护进程和执器会同时写同一个 job 文件，实测偶发 EPERM/EBUSY。
  // 重试几次比失败强——这个函数写的是任务进度，丢掉就意味着任务"凭空消失"。
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(temp, path)
      return
    } catch (error) {
      lastError = error
      if (error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'EACCES') break
      // 同步睡 15/30/60… 毫秒：这里在 promise 链上，用不着 async
      const wait = 15 * 2 ** attempt
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
      } catch {
        // 没有 SharedArrayBuffer 就直接重试
      }
    }
  }
  try {
    unlinkSync(temp)
  } catch {
    // 清不掉也无所谓
  }
  throw lastError
}

/**
 * 读 JSON（不存在或损坏时返回 fallback）。
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {T}
 */
export function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 状态文件路径。 */
export function statePath(layout) {
  return join(layout.stateDir, 'state.json')
}

/**
 * 读状态（补齐默认值）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @returns {{version: number, settings: Settings, lastCheck: object | null, skipped: Record<string, string>, lastJobId: string | null, history: object[]}}
 */
export function loadState(layout) {
  ensureDirs(layout)
  const raw = readJsonSafe(statePath(layout), {})
  const skipped = raw && typeof raw.skipped === 'object' && raw.skipped !== null ? raw.skipped : {}
  return {
    version: STATE_VERSION,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    lastCheck: raw.lastCheck ?? null,
    skipped,
    lastJobId: raw.lastJobId ?? null,
    history: Array.isArray(raw.history) ? raw.history : [],
  }
}

/**
 * 写状态。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {object} state
 */
export function saveState(layout, state) {
  ensureDirs(layout)
  writeJsonAtomic(statePath(layout), { ...state, version: STATE_VERSION })
}

/**
 * 修改设置（部分更新）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {Partial<Settings>} patch
 * @returns {Settings}
 */
export function updateSettings(layout, patch) {
  const state = loadState(layout)
  const allowed = Object.keys(DEFAULT_SETTINGS)
  const next = { ...state.settings }
  for (const key of allowed) {
    if (key in patch) next[key] = patch[key]
  }
  state.settings = next
  saveState(layout, state)
  return next
}

/** 任务文件路径。 */
function jobPath(layout, id) {  return join(layout.jobsDir, `${id}.json`)
}

/**
 * 新建任务记录。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {{kind: Job['kind'], fromVersion?: string | null, toVersion?: string | null, steps?: string[], detail?: object}} input
 * @returns {Job}
 */
export function createJob(layout, input) {
  ensureDirs(layout)
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  /** @type {Job} */
  const job = {
    id,
    kind: input.kind,
    status: 'running',
    fromVersion: input.fromVersion ?? null,
    toVersion: input.toVersion ?? null,
    phase: 'queued',
    steps: (input.steps ?? []).map((key) => ({ key, status: 'pending', startedAt: 0 })),
    startedAt: Date.now(),
    error: null,
    backupId: null,
    logPath: join(layout.logsDir, `${id}.log`),
    pluginReport: null,
    host: { restarted: false, url: null, healthChecked: false, healthMs: null },
    detail: input.detail ?? {},
  }
  writeJsonAtomic(jobPath(layout, id), job)
  appendLog(layout, job, `== job ${id} (${input.kind}) created ==`)
  const state = loadState(layout)
  state.lastJobId = id
  saveState(layout, state)
  return job
}

/**
 * 读任务。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {string} id
 * @returns {Job | null}
 */
export function readJob(layout, id) {
  return readJsonSafe(jobPath(layout, id), null)
}

/**
 * 更新任务（整体覆盖写）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {Job} job
 */
export function saveJob(layout, job) {
  writeJsonAtomic(jobPath(layout, job.id), job)
}

/**
 * 列出任务（新 → 旧）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {number} [limit]
 * @returns {Job[]}
 */
export function listJobs(layout, limit = 20) {
  ensureDirs(layout)
  const jobs = []
  /** @type {string[]} */
  let entries = []
  try {
    entries = readdirSync(layout.jobsDir)
  } catch {
    return jobs
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const job = readJsonSafe(join(layout.jobsDir, entry), null)
    if (job?.id) jobs.push(job)
  }
  jobs.sort((a, b) => b.startedAt - a.startedAt)
  return jobs.slice(0, limit)
}

/**
 * 最近的进行中任务（用于 UI 恢复进度条）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @returns {Job | null}
 */
export function currentJob(layout) {
  return listJobs(layout, 5).find((job) => job.status === 'running' || job.status === 'pending') ?? null
}

/**
 * 最近一次任务（不管什么状态）。
 *
 * 为什么需要：`currentJob` 只认"正在进行"，任务一结束它就变 null。如果界面靠
 * `currentJob` 判断进度，任务结束的那一刻它会拿不到东西，于是停在最后一次
 * 渲染出来的"正在执行"上——这正是"同步插件跑完了界面还在转圈"的成因。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @returns {Job | null}
 */
export function lastJob(layout) {
  return listJobs(layout, 1)[0] ?? null
}

/**
 * 追加一行日志。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {Job | {logPath: string}} job
 * @param {string} line
 */
export function appendLog(layout, job, line) {
  ensureDirs(layout)
  const stamp = new Date().toISOString()
  for (const single of String(line).split('\n')) {
    if (single.trim() === '') continue
    try {
      appendFileSync(job.logPath, `[${stamp}] ${single}\n`, 'utf8')
    } catch {
      // 日志写不进去不能影响主流程
    }
  }
}

/**
 * 读日志尾部。
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function tailLog(path, maxBytes = 24_000) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text
  } catch {
    return ''
  }
}

/**
 * 记录一次"跳过此版本"。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {string} version
 * @param {boolean} skip
 */
export function setSkipped(layout, version, skip = true) {
  const state = loadState(layout)
  if (skip) state.skipped[version] = new Date().toISOString()
  else delete state.skipped[version]
  saveState(layout, state)
  return state.skipped
}

/**
 * 校验并规范化来自 UI 的设置补丁。
 *
 * 设置页可以随便写，但落到 state.json 之前必须挡住非法值——尤其 `registry`，
 * 它会被拼进请求 URL，不该接受 `file:` 之类协议。
 * @param {unknown} body
 * @returns {{ok: true, value: Partial<Settings>} | {ok: false, error: string}}
 */
export function settingsPatchSchema(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: '设置必须是对象' }
  /** @type {Partial<Settings>} */
  const value = {}
  const raw = /** @type {Record<string, unknown>} */ (body)
  const bool = (key) => {
    if (!(key in raw)) return
    if (typeof raw[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    value[key] = raw[key]
  }
  const num = (key, min, max) => {
    if (!(key in raw)) return
    const parsed = Number(raw[key])
    if (!Number.isFinite(parsed)) throw new Error(`${key} 必须是数字`)
    if (parsed < min || parsed > max) throw new Error(`${key} 必须在 ${min}..${max} 之间`)
    value[key] = parsed
  }
  try {
    bool('autoCheck')
    bool('autoRollback')
    bool('syncPlugins')
    num('checkIntervalHours', 0, 24 * 7)
    num('keepBackups', 0, 10)
    num('healthTimeoutSeconds', 5, 600)
    if ('channel' in raw) {
      const channel = String(raw.channel)
      if (!['auto', 'latest', 'next', 'alpha', 'newest'].includes(channel)) throw new Error('未知的更新通道')
      value.channel = /** @type {Settings['channel']} */ (channel)
    }
    if ('backupMode' in raw) {
      const mode = String(raw.backupMode)
      if (!['full', 'metadata'].includes(mode)) throw new Error('未知的备份模式')
      value.backupMode = /** @type {Settings['backupMode']} */ (mode)
    }
    if ('registry' in raw) {
      const registry = String(raw.registry).trim().replace(/\/+$/, '')
      let parsed
      try {
        parsed = new URL(registry)
      } catch {
        throw new Error('registry 不是合法 URL')
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('registry 只支持 http/https')
      value.registry = registry
    }
    if ('dismissUntil' in raw) num('dismissUntil', 0, Date.now() + 24 * 3600_000)
  } catch (error) {
    return { ok: false, error: error.message }
  }
  if (Object.keys(value).length === 0) return { ok: false, error: '没有可更新的设置项' }
  return { ok: true, value }
}

/**
 * 清空过期任务与日志。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {number} [keep] 保留多少个任务
 */
export function pruneJobs(layout, keep = 30) {
  ensureDirs(layout)
  const jobs = listJobs(layout, 1000)
  for (const job of jobs.slice(keep)) {
    rmSync(jobPath(layout, job.id), { force: true })
    rmSync(job.logPath, { force: true })
  }
}

/**
 * 写一份人工兜底说明，摆在状态目录顶部（RECOVERY.txt）。
 *
 * 更新失败（尤其是没回滚成功）时，人打开 DSH 目录第一眼应该看到它：
 * 发生了什么、现在跑的是哪个版本、怎么手动恢复。
 * @param {Layout} layout
 * @param {Job} job
 * @param {string} reason
 * @param {string | null} version
 * @param {boolean} recovered
 */
export function writeRecovery(layout, job, reason, version, recovered) {
  const lines = [
    'dsh-auto-update 更新失败记录',
    `时间：${new Date().toISOString()}`,
    `任务：${job.id}`,
    `操作：${job.kind}`,
    `原版本：${job.fromVersion ?? '未知'}`,
    `目标版本：${job.toVersion ?? '未知'}`,
    `失败原因：${reason}`,
    recovered ? `已自动回滚到：${version ?? '未知版本'}，DSH 应可正常打开。` : '自动回滚未成功，请按下面步骤手动恢复。',
    '',
    '手动恢复办法（任选其一）：',
    '1. 用备份还原：在 DSH 设置 → 自动更新 → 备份 里选择备份点回滚；',
    `2. 命令行还原版本：npm i -g @deepseek-ai/dsh@${job.fromVersion ?? '<旧版本>'}`,
    `3. 查看完整日志：${job.logPath}`,
    `4. 备份目录：${layout.backupsDir}`,
    '',
  ].join('\n')
  try {
    writeFileSync(join(layout.stateDir, 'RECOVERY.txt'), lines, 'utf8')
  } catch {
    // 写不进就算了
  }
  try {
    appendLog(layout, job, lines)
  } catch {
    // 忽略
  }
}

/**
 * 把"上次检查结论"对齐到当前已装版本。
 *
 * 结论是带版本维度的：`installedVersion` 变了（升级/回滚过），结论就作废；
 * 目标版本恰好等于当前版本时也不算"有新版本"。两处调用（宿主 /status、CLI status）
 * 必须用同一套规则，否则一边显示"有新版本"、一边显示"已最新"。
 * @param {any} lastCheck
 * @param {string} [installedVersion]
 * @returns {any}
 */
export function normalizeLastCheck(lastCheck, installedVersion) {
  if (!lastCheck || typeof lastCheck !== 'object') return lastCheck
  const drifted = Boolean(lastCheck.installedVersion && installedVersion && lastCheck.installedVersion !== installedVersion)
  if (drifted) return { ...lastCheck, stale: true, available: false, alreadyLatest: false }
  const sameTarget = Boolean(installedVersion && lastCheck.targetVersion && lastCheck.targetVersion === installedVersion)
  if (sameTarget) return { ...lastCheck, available: false, alreadyLatest: true }
  return lastCheck
}

/** 进程是否还活着（EPERM 表示存在但权限不同，也算活着）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * 对账：把"写着正在执行、其实执行器已经没了"的任务收尾。
 *
 * 场景：同步插件/更新跑在独立命令行窗口里，用户把窗口关了（或机器重启、进程被结束），
 * 执行器来不及写结论 → 任务永远停在 running → 界面永远显示"正在执行"。
 * 判据取执行器自己每秒刷新的心跳文件，而不是别人的文件时间。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {Job | null} job
 * @param {{staleMs?: number, graceMs?: number}} [options]
 * @returns {Job | null}
 */
export function reconcileJob(layout, job, options = {}) {
  if (!job) return job
  if (job.status !== 'running' && job.status !== 'pending') return job
  const staleMs = options.staleMs ?? 20_000
  const graceMs = options.graceMs ?? 30_000
  const startedAt = Number(job.startedAt ?? 0)
  const runningFor = startedAt ? Date.now() - startedAt : 0

  /** @type {{ts?: number, pid?: number} | null} */
  let beat = null
  try {
    beat = JSON.parse(readFileSync(join(layout.jobsDir, `${job.id}.hb`), 'utf8'))
  } catch {
    beat = null
  }
  let pid = Number(beat?.pid ?? 0)
  if (!pid) {
    try {
      pid = Number(readFileSync(join(layout.jobsDir, `${job.id}.pid`), 'utf8').trim())
    } catch {
      pid = 0
    }
  }

  const beatAge = beat?.ts ? Date.now() - Number(beat.ts) : null
  let reason = ''

  if (job.status === 'pending' && runningFor > graceMs) {
    reason = '任务创建后执行器一直没有启动（命令行窗口没打开就被关掉了？）'
  } else if (pid > 0 && !pidAlive(pid) && (beatAge === null || beatAge > staleMs)) {
    reason = `执行器进程 ${pid} 已经退出，但任务没有写完结论（命令行窗口被关掉了？）`
  } else if (beatAge !== null && beatAge > staleMs) {
    reason = `执行器心跳已经停了 ${Math.round(beatAge / 1000)} 秒（进程可能被挂起或窗口被关掉）`
  } else if (beatAge === null && job.status === 'running' && runningFor > graceMs) {
    reason = '执行器一直没写出心跳（进程没有真正跑起来）'
  }

  if (!reason) return job
  const failed = {
    ...job,
    status: 'failed',
    phase: 'failed',
    error: reason,
    endedAt: Date.now(),
  }
  try {
    saveJob(layout, failed)
  } catch {
    // 收尾写不进去也要把结论返回给界面
  }
  return failed
}
