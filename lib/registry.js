/**
 * npm registry 访问：查询 DSH 与本地插件的可用版本。
 *
 * 不引入任何依赖，用 node 内建的 http/https 发请求；请求走 abbreviated
 * packument（`application/vnd.npm.install-v1+json`），体积小、字段够用。
 *
 * 为什么不用全局 fetch：Windows 上很多机器没有可用 IPv6，而 fetch 会先连 AAAA 记录，
 * 遇到黑洞路由要干等 10 秒才回落到 IPv4（实测 `Connect Timeout Error (attempted
 * addresses: 2606:4700::...)`）。这里显式优先 IPv4，失败再退回默认解析顺序，
 * 避免"检查更新一直转圈"。
 * @module dsh-auto-update/registry
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { gt, highest, maxSatisfying, sortDesc } from './semver.js'

/** 默认 registry。 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** 等一会儿（重试用）。 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** npm 精简元数据 media type。 */
const PACKUMENT_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8'

/**
 * 把包名编码成 registry 路径（作用域包的 `/` 必须转义成 `%2F`）。
 * @param {string} name 例如 '@deepseek-ai/dsh'
 * @returns {string}
 */
export function packumentUrl(name, registry = DEFAULT_REGISTRY) {
  return `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2F')}`
}

/**
 * 发一个 GET 并把 JSON 解析出来（超时/HTTP 状态/JSON 错误都抛中文错误）。
 *
 * @param {string} url
 * @param {{timeoutMs?: number, headers?: Record<string, string>, family?: 0 | 4 | 6}} [options]
 * @returns {Promise<any>}
 */
export function httpGetJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 12_000
  return new Promise((resolve, reject) => {
    /** @type {URL} */
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`registry 地址不是合法 URL：${url}`))
      return
    }
    const secure = parsed.protocol === 'https:'
    const send = secure ? httpsRequest : httpRequest
    /** @type {Record<string, any>} */
    const requestOptions = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: { accept: PACKUMENT_ACCEPT, 'user-agent': 'dsh-auto-update', ...(options.headers ?? {}) },
      timeout: timeoutMs,
    }
    if (options.family) requestOptions.family = options.family
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const req = send(requestOptions, (res) => {
      const status = res.statusCode ?? 0
      if (status === 404) {
        res.resume()
        finish(reject, new Error(`registry 中没有这个包（HTTP 404）`))
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        finish(reject, new Error(`registry 返回 HTTP ${status}`))
        return
      }
      let size = 0
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (chunk) => {
        size += chunk.length
        // abbreviated packument 一般几十 KB；给到 32MB 已经远超任何正常包
        if (size > 32 * 1024 * 1024) {
          req.destroy(new Error('registry 响应过大'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        try {
          finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          finish(reject, new Error('registry 返回的内容不是合法 JSON'))
        }
      })
      res.on('error', (error) => finish(reject, error))
    })
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`))
    })
    req.on('error', (error) => finish(reject, error))
    req.end()
  })
}

/**
 * 取一个包的仓库元数据。
 *
 * 先强制 IPv4（见文件头注释），失败且不是"包不存在/HTTP 错"时按默认解析顺序再试一次。
 * @param {string} name 包名
 * @param {{registry?: string, timeoutMs?: number, fetchImpl?: (url: string, options?: any) => Promise<any>, authorization?: string}} [options]
 * @returns {Promise<{name: string, distTags: Record<string, string>, versions: string[], time: Record<string, string>, raw: any}>}
 */
export async function fetchPackument(name, options = {}) {
  const registry = options.registry || DEFAULT_REGISTRY
  const timeoutMs = options.timeoutMs ?? 12_000
  const url = packumentUrl(name, registry)
  const headers = {}
  if (options.authorization) headers.authorization = options.authorization
  const fetcher = options.fetchImpl
  let body
  if (fetcher) {
    body = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } else {
    // 首次出网连接偶尔会被本机防火墙/代理 reset 或拖到超时（实测：同一个进程里
    // 第一次请求超时、第二次成功），所以按"IPv4 → IPv4 → 默认解析顺序"重试三轮。
    const plans = [
      { family: 4, delay: 0 },
      { family: 4, delay: 400 },
      { family: 0, delay: 1200 },
    ]
    /** @type {Error | null} */
    let lastError = null
    for (const plan of plans) {
      if (plan.delay > 0) await delay(plan.delay)
      try {
        body = await httpGetJson(url, { timeoutMs, headers, family: plan.family })
        lastError = null
        break
      } catch (error) {
        lastError = error
        // 包不存在、HTTP 状态错、响应体坏掉：重试没有意义
        if (/HTTP \d+|不是合法 JSON|响应过大|不是合法 URL/.test(error.message)) break
      }
    }
    if (!body) {
      throw new Error(`无法访问 registry（${registry}）：${lastError?.message ?? '未知错误'}`)
    }
  }
  const distTags = body['dist-tags'] && typeof body['dist-tags'] === 'object' ? body['dist-tags'] : {}
  const versionRecord = body.versions && typeof body.versions === 'object' ? body.versions : {}
  const versions = Object.keys(versionRecord).filter((version) => typeof version === 'string')
  return {
    name: body.name ?? name,
    distTags,
    /** 版本号字符串数组（供版本排序/挑选用）。 */
    versions,
    /** 版本号 → manifest。compat 判定 peerDependencies 时必须用这个（别把它当数组）。 */
    manifests: versionRecord,
    time: body.time && typeof body.time === 'object' ? body.time : {},
    raw: body,
  }
}

/**
 * 更新通道。
 * @typedef {'auto' | 'latest' | 'next' | 'alpha' | 'newest'} Channel
 */

/**
 * 依据通道挑选候选目标版本。
 *
 * - `auto`：当前装的是预发布版就跟随 `next`，否则跟随 `latest`（npm 的常规语义）。
 * - `latest` / `next` / `alpha`：直接取对应 dist-tag。
 * - `newest`：取所有版本里最高的一个（含预发布），是最激进的选项。
 *
 * @param {object} input
 * @param {string} input.installedVersion 已安装版本
 * @param {Record<string, string>} input.distTags
 * @param {string[]} input.versions
 * @param {Channel} [input.channel]
 * @param {Record<string, string>} [input.time] 版本发布时间，用于摘要展示
 * @returns {{channel: Exclude<Channel, 'auto'>, tag: string | null, version: string | null, isPrerelease: boolean, publishedAt: string | null}}
 */
export function pickTargetVersion(input) {
  const installedPrerelease = typeof input.installedVersion === 'string' && input.installedVersion.includes('-')
  const channel = input.channel && input.channel !== 'auto'
    ? input.channel
    : installedPrerelease && input.distTags.next ? 'next' : 'latest'
  let version = null
  let tag = null
  if (channel === 'newest') {
    version = highest(input.versions)
  } else {
    tag = channel
    version = input.distTags[channel] ?? null
    // dist-tag 缺失时退回到 latest，避免"通道配错就永远查不到更新"
    if (!version && input.distTags.latest) {
      version = input.distTags.latest
      tag = 'latest'
    }
  }
  const publishedAt = version ? input.time?.[version] ?? null : null
  return {
    channel: /** @type {any} */ (channel),
    tag,
    version,
    isPrerelease: Boolean(version && version.includes('-')),
    publishedAt,
  }
}

/**
 * 查 DSH 自己的版本信息，并给出"是否有新版"的结论。
 * @param {object} input
 * @param {string} input.installedVersion
 * @param {string} [input.registry]
 * @param {Channel} [input.channel]
 * @param {string[] | Record<string, string>} [input.skipVersions] 用户选择"跳过此版本"的清单
 * @param {typeof fetch} [input.fetchImpl]
 * @param {number} [input.timeoutMs]
 * @returns {Promise<object>}
 */
export async function checkDshUpdate(input) {
  const packument = await fetchPackument('@deepseek-ai/dsh', {
    registry: input.registry,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  const target = pickTargetVersion({
    installedVersion: input.installedVersion,
    distTags: packument.distTags,
    versions: packument.versions,
    channel: input.channel,
    time: packument.time,
  })
  // 跳过清单在状态文件里是 {版本: 跳过时间}，也允许直接传数组
  const skipVersions = new Set(
    Array.isArray(input.skipVersions) ? input.skipVersions : Object.keys(input.skipVersions ?? {}),
  )
  // 只有目标版本严格高于已装版本才算“有新版”；降级/同版本一律不提示
  const newer = target.version ? gt(target.version, input.installedVersion) : false
  return {
    checkedAt: new Date().toISOString(),
    installedVersion: input.installedVersion,
    channel: target.channel,
    distTags: packument.distTags,
    latest: packument.distTags.latest ?? null,
    targetVersion: target.version,
    targetTag: target.tag,
    targetPublishedAt: target.publishedAt,
    isPrerelease: target.isPrerelease,
    available: newer,
    skipped: target.version ? skipVersions.has(target.version) : false,
    recentVersions: sortDesc(packument.versions).slice(0, 12).map((version) => ({
      version,
      publishedAt: packument.time?.[version] ?? null,
      tags: Object.entries(packument.distTags)
        .filter(([, value]) => value === version)
        .map(([name]) => name),
    })),
  }
}

/**
 * 在某个包的已发布版本里，找出最高且满足 `range` 的版本（用于插件同步升级）。
 * @param {string} name
 * @param {string} range
 * @param {{registry?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<{version: string | null, latest: string | null, versions: string[]}>}
 */
export async function findHighestSatisfying(name, range, options = {}) {
  const packument = await fetchPackument(name, options)
  const sorted = sortDesc(packument.versions)
  return {
    version: maxSatisfying(sorted, range, { includePrerelease: true }),
    latest: packument.distTags.latest ?? null,
    versions: sorted,
  }
}

/**
 * 供 UI 展示用的"版本摘要"：最近若干版本的发布时间。
 * @param {string[]} versions
 * @param {Record<string, string>} time
 * @param {number} limit
 * @returns {{version: string, publishedAt: string | null}[]}
 */
export function versionDigest(versions, time, limit = 8) {
  return sortDesc(versions)
    .slice(0, limit)
    .map((version) => ({ version, publishedAt: time?.[version] ?? null }))
}
