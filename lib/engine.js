/**
 * dsh-image-switch —— 生图后端引擎（Host 侧核心）
 *
 * 这个文件是**唯一**一套路由逻辑，两个出口共用它：
 *   1. `server.js` 起的独立监听（默认 127.0.0.1:17891）—— 提供给 dsh-model-think-level
 *      的 `img-router` provider 当上游，路径就是标准 OpenAI `/v1/images/*`。
 *   2. `index.js` 挂在 webServer 上的 `/api/image-switch/*` —— 给 DSH 设置页用，
 *      同源、无 CORS。
 *
 * 为什么要一个独立端口而不是只用 webServer：dsh-model-think-level 的 provider
 * baseURL 是在 profile 配置里写死的字符串，而 DSH 的 web 端口会变（4875 → 7726
 * 就发生过一次）。写死一个自有端口，DSH 换端口时上游链路不受影响。
 *
 * @module lib/engine
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import https from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/* ------------------------------------------------------------------ *
 * 存储位置
 * ------------------------------------------------------------------ */

const HOME = os.homedir()
export const STATE_DIR = path.join(HOME, '.dsh', 'image-switch')
export const CONFIG_PATH = path.join(STATE_DIR, 'config.json')
const KEYS_PATH = path.join(STATE_DIR, 'keys.json')

/* ------------------------------------------------------------------ *
 * 默认后端
 * ------------------------------------------------------------------ */

/**
 * kind 的语义：
 *   'ark'    —— 火山方舟 /images/generations，参数体是豆包那套（无 quality、有 watermark、size 只认 1K/2K）
 *   'openai' —— 标准 OpenAI 兼容（原样转发 size / n / quality，除非 stripQuality）
 *   'video'  —— 异步视频任务（SCNet / MiniMax-H3 这一套）：
 *               POST /videos/generations 拿 task_id，GET /tasks/{id} 轮询，
 *               拿到 mp4 后下载落盘，再抽帧回 PNG 给 generate_image 吃
 */
export function defaultConfig() {
  return {
    version: 1,
    active: 'local',
    /** 写进上游请求的阶段提示；UI 顶部展示用 */
    routeName: 'img-router',
    backends: {
      doubao: {
        label: '豆包 Seedream（火山方舟）',
        kind: 'ark',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-seedream-5-5-261028',
        apiKeyEnv: 'ARK_API_KEY',
        watermark: false,
        sizeFallback: '2K'
      },
      autodl: {
        label: 'AutoDL.Art 豆包 Seedream 5.0 flash',
        kind: 'openai',
        baseURL: 'https://www.autodl.art/api/v1',
        model: 'doubao-seedream-5-0-flash',
        apiKeyEnv: 'AUTODL_ART_API_KEY',
        authPrefix: '',
        stripQuality: true
      },
      autodlz: {
        label: 'AutoDL.Art Z-Image-Turbo',
        kind: 'openai',
        baseURL: 'https://www.autodl.art/api/v1',
        model: 'Z-Image-Turbo',
        apiKeyEnv: 'AUTODL_ART_API_KEY',
        authPrefix: '',
        stripQuality: true
      },
      supooo: {
        label: 'Supooo 聚合（supooo.image）',
        kind: 'openai',
        baseURL: 'https://www.supooo.com/v1',
        model: 'supooo.image',
        apiKeyEnv: 'SUPOOO_API_KEY'
      },
      scnet: {
        label: 'SCNet MiniMax-H3（视频，抽帧回图）',
        kind: 'video',
        baseURL: 'https://api.scnet.cn/api/llm/v1',
        model: 'MiniMax-H3',
        apiKeyEnv: 'SCNET_API_KEY',
        videoResolution: '768P',
        videoDuration: 5,
        videoRatio: '16:9',
        videoFrames: 1,
        videoPollMs: 5000,
        videoTimeoutMs: 600000,
        watermark: false
      },
      local: {
        label: '本地 写实人像 Realistic Vision V6',
        kind: 'openai',
        baseURL: 'http://127.0.0.1:17890/v1',
        model: 'sd1.5',
        apiKey: 'local',
        apiKeyEnv: '',
        stripQuality: true
      },
      'local-base': {
        label: '本地 SD 1.5 原版（通用底模）',
        kind: 'openai',
        baseURL: 'http://127.0.0.1:17890/v1',
        model: 'sd15-base',
        apiKey: 'local',
        apiKeyEnv: '',
        stripQuality: true
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

function ensureDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  } catch {
    /* 已存在就算了 */
  }
}

/** 从旧版 image-shim 的 shim.json 里捞已有配置（首次运行时迁移一次） */
function legacyShimConfig() {
  const file = path.join(HOME, 'Downloads', 'yingyong', 'image-shim', 'shim.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 旧版本插件（dsh-image-router）存过一份，改名后顺手接过来 */
const LEGACY_STATE_DIR = path.join(HOME, '.dsh', 'image-router')

function legacyStateConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, 'config.json'), 'utf8'))
  } catch {
    return null
  }
}

function legacyStateKeys() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LEGACY_STATE_DIR, 'keys.json'), 'utf8'))
  } catch {
    return null
  }
}

export function loadConfig() {
  const base = defaultConfig()
  let stored = null
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    stored = null
  }

  // 从旧版插件目录迁移一次（改名 dsh-image-router → dsh-image-switch 之后）
  if (stored === null) {
    const previous = legacyStateConfig()
    if (previous && previous.backends) {
      for (const [name, spec] of Object.entries(previous.backends)) {
        base.backends[name] = { ...(base.backends[name] ?? {}), ...spec }
      }
      if (typeof previous.active === 'string' && base.backends[previous.active]) {
        base.active = previous.active
      }
      const previousKeys = legacyStateKeys()
      if (previousKeys && typeof previousKeys === 'object') {
        ensureDir()
        fs.writeFileSync(KEYS_PATH, JSON.stringify(previousKeys, null, 2), {
          encoding: 'utf8',
          mode: 0o600
        })
      }
      saveConfig(base)
      return base
    }
  }

  // 第一次运行：把旧 image-shim 的后端与密钥接过来，不让用户白填一遍
  if (stored === null) {
    const legacy = legacyShimConfig()
    if (legacy && legacy.backends) {
      for (const [name, spec] of Object.entries(legacy.backends)) {
        base.backends[name] = { ...(base.backends[name] ?? {}), ...spec }
      }
      if (typeof legacy.active === 'string') base.active = legacy.active
    }
    saveConfig(base)
    return base
  }

  const merged = { ...base, ...stored }
  // 内置后端也要能被删掉：删过的名字记在 removed 里，不再从 defaultConfig 合并回来
  const removed = new Set(
    Array.isArray(stored.removed) ? stored.removed.filter((name) => typeof name === 'string') : []
  )
  merged.removed = [...removed]
  merged.backends = {}
  for (const [name, spec] of Object.entries(base.backends)) {
    if (removed.has(name)) continue
    merged.backends[name] = { ...spec }
  }
  for (const [name, spec] of Object.entries(stored.backends ?? {})) {
    if (removed.has(name)) continue
    merged.backends[name] = { ...(base.backends[name] ?? {}), ...spec }
  }
  if (!merged.backends[merged.active]) merged.active = Object.keys(merged.backends)[0] ?? 'local'
  return merged
}

export function saveConfig(config) {
  ensureDir()
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

function loadKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveKeys(keys) {
  ensureDir()
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/* ------------------------------------------------------------------ *
 * 密钥解析：面板填的 → 环境变量 → ~/.dsh/.credentials.yaml
 * ------------------------------------------------------------------ */

const CREDENTIALS_FILE = path.join(HOME, '.dsh', '.credentials.yaml')

function keyFromDshRefs(name) {
  if (!name) return ''
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8')
    // refs 段形如 `  ARK_API_KEY: xxxxx`，只认两格缩进的 `名字: 值`
    const match = new RegExp(`^\\s{2}${name}:\\s*(\\S+)\\s*$`, 'm').exec(text)
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

export function apiKeyOf(name, backend, keys = loadKeys()) {
  const fromPanel = keys[name]
  if (typeof fromPanel === 'string' && fromPanel.trim().length > 0) return fromPanel.trim()
  if (backend.apiKey && String(backend.apiKey).trim().length > 0) return String(backend.apiKey).trim()
  if (backend.apiKeyEnv && process.env[backend.apiKeyEnv]) return String(process.env[backend.apiKeyEnv]).trim()
  return keyFromDshRefs(backend.apiKeyEnv)
}

/** 面板里只显示指纹，不把整把 key 送进浏览器 */
export function keyHint(key) {
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 4)}…${key.slice(-4)}（${key.length} 位）`
}

/* ------------------------------------------------------------------ *
 * 参数翻译
 * ------------------------------------------------------------------ */

const SIZE_ALIASES = {
  '512x512': '1K',
  '768x768': '1K',
  '1024x1024': '1K',
  '1280x720': '1K',
  '720x1280': '1K',
  '1152x864': '1K',
  '1536x1536': '1.5K',
  '2048x2048': '2K',
  '1440x2560': '2K',
  '2560x1440': '2K'
}

/** ARK 只认 1K / 1.5K / 2K / auto，或 [921600, 4624220] 像素区间内的 WxH */
export function arkSize(size, fallback = '2K') {
  if (typeof size !== 'string' || size.length === 0) return fallback
  const lower = size.toLowerCase().trim()
  if (lower === 'auto') return 'auto'
  if (lower === '4k') return '2K'
  if (lower === '1k' || lower === '1.5k' || lower === '2k') return lower.toUpperCase()
  const m = /^(\d+)\s*[x*]\s*(\d+)$/.exec(lower)
  if (!m) return fallback
  const w = Number(m[1])
  const h = Number(m[2])
  const pixels = w * h
  const ratio = w / h
  if (pixels >= 921600 && pixels <= 4624220 && ratio >= 1 / 16 && ratio <= 16) return `${w}x${h}`
  if (SIZE_ALIASES[lower]) return SIZE_ALIASES[lower]
  return pixels < 921600 ? '1K' : '2K'
}

function authValue(backend, key) {
  const prefix = backend.authPrefix === undefined ? 'Bearer ' : String(backend.authPrefix)
  return `${prefix}${key}`
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

/**
 * 底层 HTTP 请求：走 node:http/https，并且 **强制 family: 4**。
 *
 * 为什么不用全局 fetch：Node 22+ 的 undici 走 Happy Eyeballs（autoSelectFamily），
 * 在部分网络（IPv6 有路由但连不通）下会先试 v6 并一直等到超时，报成
 * “fetch failed / UND_ERR_CONNECT_TIMEOUT”。api.scnet.cn 就是这种：
 * curl 和 node:https 都正常，只有 fetch 连不上。这里绕开 undici 直连。
 */
export function rawRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 60_000, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`不是合法 URL：${url}`))
      return
    }
    const isHttps = target.protocol === 'https:'
    const agent = isHttps
      ? new https.Agent({ keepAlive: false, family: 4 })
      : new http.Agent({ keepAlive: false, family: 4 })
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    const req = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'content-length': payload.length } : {})
        },
        agent,
        family: 4,
        timeout: timeoutMs
      },
      (res) => {
        const location = res.headers.location
        // 上游图床/CDN 基本都会 302 到真实对象地址，这里自己跟，最多 5 跳
        if (location && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308)) {
          res.resume()
          if (redirects >= 5) {
            reject(new Error(`重定向次数过多：${url}`))
            return
          }
          const next = new URL(location, target).toString()
          rawRequest(next, { method: res.statusCode === 303 ? 'GET' : method, headers, body, timeoutMs, redirects: redirects + 1 })
            .then(resolve, reject)
          return
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          const text = buffer.toString('utf8')
          let json
          try {
            json = text.trim().length === 0 ? undefined : JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            headers: res.headers,
            buffer,
            text,
            json
          })
        })
        res.on('error', reject)
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）：${target.host}`))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function upstreamError(label, response, text, body) {
  const raw =
    body?.error?.message ??
    body?.error?.code ??
    body?.message ??
    body?.msg ??
    (typeof text === 'string' ? text.slice(0, 400) : '') ??
    `HTTP ${response.status}`
  // 把网关常见的业务码翻成人话，省得用户自己猜 200100 是什么
  let message = raw
  if (body?.code === '200100' || /reached the quota/i.test(String(raw))) {
    message = `每日请求配额已用完（${raw}）；配额按天重置，换 key 或次日再试`
  } else if (response.status === 401 || body?.code === '10014') {
    message = `鉴权失败：${raw}`
  } else if (response.status === 429) {
    message = `被上游限流：${raw}`
  }
  const error = new Error(`${label}：${message}`)
  error.status = response.status
  return error
}

async function fetchJson(url, init) {
  // multipart（图生图）交给全局 fetch：FormData 的分块编码只有它认
  if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
    const response = await fetch(url, init)
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    return { response, text, body }
  }
  const response = await rawRequest(url, init)
  return { response, text: response.text, body: response.json }
}

/**
 * normalizeImages 之后统一转 PNG。
 *
 * 宿主按 `image/png` 声明校验字节，上游给 JPEG 会直接判为格式不符；
 * 所以出口处一律归一，调用方不用关心各家返回什么格式。
 */
async function ensurePng(result) {
  const data = []
  for (const item of result.data) {
    const bytes = Buffer.from(item.b64_json, 'base64')
    const png = await toPng(bytes)
    data.push({ b64_json: png === bytes ? item.b64_json : png.toString('base64') })
  }
  return { created: result.created, data }
}

async function asBase64(source) {
  if (source.startsWith('data:')) return source.replace(/^data:[^,]+,/, '')
  const response = await rawRequest(source, { method: 'GET', timeoutMs: 120_000 })
  if (!response.ok) throw new Error(`下载上游图片失败（HTTP ${response.status}）`)
  return response.buffer.toString('base64')
}

/** 统一成 {created, data:[{b64_json}]}：有 b64 就用，只给 url 就下载回来 */
async function normalizeImages(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : []
  if (list.length === 0) {
    for (const key of ['images', 'output', 'result']) {
      const nested = payload?.[key]
      if (Array.isArray(nested) && nested.length > 0) return normalizeImages({ data: nested })
    }
    throw new Error('上游没有返回任何图片（data 为空）')
  }
  const out = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      out.push({ b64_json: await asBase64(entry) })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.b64_json === 'string' && entry.b64_json) {
      out.push({ b64_json: entry.b64_json })
      continue
    }
    const url = entry.url ?? entry.image_url ?? entry.imageUrl
    if (typeof url === 'string' && url) {
      out.push({ b64_json: await asBase64(url) })
      continue
    }
    const inline = entry.image ?? entry.image_base64 ?? entry.base64
    if (typeof inline === 'string' && inline) out.push({ b64_json: inline.replace(/^data:[^,]+,/, '') })
  }
  if (out.length === 0) throw new Error('上游返回的图片既没有 b64_json 也没有 url')
  return { created: Math.floor(Date.now() / 1000), data: out }
}

function trimBase(backend) {
  return String(backend.baseURL ?? '').replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ *
 * 统一成 PNG
 * ------------------------------------------------------------------ */

/*
 * 为什么必须转：dsh-model-think-level 落盘时 mime 写死 `image/png`
 * （lib/index.js 里 `mime: "image/png"`），宿主再按声明类型校验字节。
 * 豆包 Seedream 返回的是 **JPEG**（magic ffd8ffe0），直接塞过去就报
 * “Declared image type does not match its bytes”，图生成了却挂不上对话。
 * 所以这里把非 PNG 的字节转成真 PNG 再交出去，不依赖上游给什么格式。
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function isPng(buffer) {
  return buffer.length > 8 && buffer.slice(0, 4).equals(PNG_MAGIC)
}

const FFMPEG_CANDIDATES = [
  process.env.IMAGE_ROUTER_FFMPEG,
  path.join(HOME, '.dsh', 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  'ffmpeg'
].filter((item) => typeof item === 'string' && item.length > 0)

const PYTHON_CANDIDATES = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']

let workingConverter

function tmpFile(ext) {
  ensureDir()
  const dir = path.join(STATE_DIR, 'tmp')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 已存在 */
  }
  return path.join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
}

async function viaFfmpeg(binary, source) {
  const input = tmpFile('bin')
  const output = tmpFile('png')
  fs.writeFileSync(input, source)
  try {
    await execFileAsync(binary, ['-y', '-loglevel', 'error', '-i', input, '-f', 'image2', '-vcodec', 'png', output], {
      timeout: 30_000,
      windowsHide: true
    })
    const png = fs.readFileSync(output)
    if (!isPng(png)) throw new Error('ffmpeg 没产出 PNG')
    return png
  } finally {
    for (const file of [input, output]) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 清不掉就算了 */
      }
    }
  }
}

async function viaPython(binary, source) {
  const input = tmpFile('bin')
  const output = tmpFile('png')
  fs.writeFileSync(input, source)
  const script = 'from PIL import Image; import sys; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "PNG")'
  try {
    await execFileAsync(binary, ['-c', script, input, output], { timeout: 30_000, windowsHide: true })
    const png = fs.readFileSync(output)
    if (!isPng(png)) throw new Error('PIL 没产出 PNG')
    return png
  } finally {
    for (const file of [input, output]) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 清不掉就算了 */
      }
    }
  }
}

/**
 * 把任意图片字节转成 PNG。已经是 PNG 就原样返回。
 *
 * 转换器依次试：环境变量指定的 ffmpeg → 常见安装位置的 ffmpeg → PATH 里的 ffmpeg
 * → python + Pillow。第一个成功的会被记住，后续图不再逐个探测。
 */
export async function toPng(source) {
  if (isPng(source)) return source

  if (workingConverter) {
    try {
      return workingConverter.kind === 'ffmpeg'
        ? await viaFfmpeg(workingConverter.binary, source)
        : await viaPython(workingConverter.binary, source)
    } catch {
      workingConverter = undefined
    }
  }

  for (const binary of FFMPEG_CANDIDATES) {
    try {
      const png = await viaFfmpeg(binary, source)
      workingConverter = { kind: 'ffmpeg', binary }
      return png
    } catch {
      /* 换下一个 */
    }
  }
  for (const binary of PYTHON_CANDIDATES) {
    try {
      const png = await viaPython(binary, source)
      workingConverter = { kind: 'python', binary }
      return png
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('上游返回的不是 PNG，且本机找不到可用的图片转换器（ffmpeg 或 python+Pillow）')
}

/* ------------------------------------------------------------------ *
 * 文生图
 * ------------------------------------------------------------------ */

async function arkGenerate(name, backend, { prompt, size, n }) {
  const key = apiKeyOf(name, backend)
  if (!key) {
    const error = new Error(
      `豆包 ARK 还没密钥：在「生图路由」设置页填 ARK_API_KEY，或设置环境变量 ${backend.apiKeyEnv || 'ARK_API_KEY'}`
    )
    error.status = 400
    throw error
  }
  const count = Math.max(1, Math.min(8, Number(n) || 1))
  const images = []
  for (let index = 0; index < count; index += 1) {
    const payload = {
      model: backend.model,
      prompt,
      size: arkSize(size, backend.sizeFallback),
      response_format: 'b64_json',
      watermark: backend.watermark === true
    }
    const { response, text, body } = await fetchJson(`${trimBase(backend)}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload)
    })
    if (!response.ok) throw upstreamError(`豆包 ARK`, response, text, body)
    images.push(...(await ensurePng(await normalizeImages(body))).data)
  }
  return { created: Math.floor(Date.now() / 1000), data: images }
}

async function openaiGenerate(name, backend, { prompt, size, n, quality }) {
  const key = apiKeyOf(name, backend)
  const payload = { model: backend.model, prompt, n: Math.max(1, Number(n) || 1) }
  if (size) payload.size = size
  if (quality && backend.stripQuality !== true) payload.quality = quality
  const { response, text, body } = await fetchJson(`${trimBase(backend)}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: authValue(backend, key) } : {}) },
    body: JSON.stringify(payload)
  })
  if (!response.ok) throw upstreamError(backend.label || backend.model, response, text, body)
  return ensurePng(await normalizeImages(body))
}

/* ------------------------------------------------------------------ *
 * 图生图
 * ------------------------------------------------------------------ */

async function arkEdit(name, backend, { prompt, size, files }) {
  const key = apiKeyOf(name, backend)
  if (!key) {
    const error = new Error(`豆包 ARK 还没密钥：在「生图路由」设置页填 ${backend.apiKeyEnv || 'ARK_API_KEY'}`)
    error.status = 400
    throw error
  }
  const image = files.map((file) => `data:${file.mime};base64,${file.bytes.toString('base64')}`)
  const payload = {
    model: backend.model,
    prompt,
    image: image.length === 1 ? image[0] : image,
    size: arkSize(size, backend.sizeFallback),
    response_format: 'b64_json',
    watermark: backend.watermark === true
  }
  const { response, text, body } = await fetchJson(`${trimBase(backend)}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload)
  })
  if (!response.ok) throw upstreamError('豆包 ARK 图生图', response, text, body)
  return ensurePng(await normalizeImages(body))
}

async function openaiEdit(name, backend, { prompt, size, n, files }) {
  const key = apiKeyOf(name, backend)
  const form = new FormData()
  form.set('model', backend.model)
  form.set('prompt', prompt)
  form.set('n', String(Math.max(1, Number(n) || 1)))
  if (size) form.set('size', size)
  for (const file of files) form.append('image[]', new Blob([file.bytes], { type: file.mime }), file.name)
  const { response, text, body } = await fetchJson(`${trimBase(backend)}/images/edits`, {
    method: 'POST',
    headers: key ? { authorization: authValue(backend, key) } : undefined,
    body: form
  })
  if (!response.ok) throw upstreamError(`${backend.label || backend.model} 图生图`, response, text, body)
  return ensurePng(await normalizeImages(body))
}

/* ------------------------------------------------------------------ *
 * 视频（异步任务）—— SCNet / MiniMax-H3
 * ------------------------------------------------------------------ */

const VIDEO_DIR = path.join(STATE_DIR, 'videos')

function ensureVideoDir() {
  try {
    fs.mkdirSync(VIDEO_DIR, { recursive: true })
  } catch {
    /* 已存在 */
  }
  return VIDEO_DIR
}

/**
 * 从任务查询的 payload 里挖出视频地址。
 *
 * SCNet 这类网关的返回结构各家不一样，不猜死的路径，按常见字段名递归找：
 * 只要某个字符串字段以 .mp4/.webm/.mov 结尾或是 http 且带 video 字样，就当视频地址。
 */
function findVideoUrl(payload) {
  const wanted = /\.(mp4|webm|mov|m4v)(\?|$)/i
  const seen = new Set()
  let hit
  const walk = (node, depth) => {
    if (hit !== undefined || depth > 6 || node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    for (const [key, value] of Object.entries(node)) {
      if (hit !== undefined) return
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        if (wanted.test(value) || /video/i.test(key) || /video/i.test(value)) {
          hit = value
          return
        }
      } else if (value !== null && typeof value === 'object') {
        walk(value, depth + 1)
      }
    }
  }
  walk(payload, 0)
  return hit
}

/** 任务状态归一：succeed/processing/failed 这些词各家写法不同，统一成三种 */
function normalizeTaskStatus(payload) {
  const candidates = [
    payload?.status,
    payload?.state,
    payload?.data?.status,
    payload?.data?.state,
    payload?.output?.task_status,
    payload?.task_status,
    payload?.data?.task_status
  ]
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const value = raw.toLowerCase()
    if (/fail|error|cancel|reject/.test(value)) return 'failed'
    if (/succeed|success|complete|finished|\bdone\b|^ok$/.test(value)) return 'succeeded'
    if (/queue|pending|wait|process|running|submit|start/.test(value)) return 'running'
  }
  return 'unknown'
}

function findTaskId(payload) {
  const candidates = [
    payload?.task_id,
    payload?.taskId,
    payload?.id,
    payload?.data?.task_id,
    payload?.data?.taskId,
    payload?.data?.id,
    payload?.output?.task_id,
    payload?.result?.task_id
  ]
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  }
  return undefined
}

/** 抽帧：把 mp4 的第 N 个关键画面导成 PNG（ffmpeg 优先，python 兜底） */
async function grabFrame(videoBytes, index, total) {
  ensureVideoDir()
  const input = path.join(ensureVideoDir(), `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`)
  const output = tmpFile('png')
  fs.writeFileSync(input, videoBytes)
  // 均匀取帧：第 1 张取 10% 处（避开片头黑帧），后续按比例往后推
  const position = total <= 1 ? 0.1 : 0.1 + (index / total) * 0.7
  try {
    for (const binary of FFMPEG_CANDIDATES) {
      try {
        await execFileAsync(
          binary,
          ['-y', '-loglevel', 'error', '-ss', position.toFixed(3), '-i', input, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', output],
          { timeout: 60_000, windowsHide: true }
        )
        const png = fs.readFileSync(output)
        if (isPng(png)) {
          workingConverter = { kind: 'ffmpeg', binary }
          return png
        }
      } catch {
        /* 换下一个转换器 */
      }
    }
    throw new Error('抽帧失败：本机没有可用的 ffmpeg')
  } finally {
    for (const file of [input, output]) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 清不掉就算了 */
      }
    }
  }
}

function videoParams(backend, params) {
  return {
    resolution: String(backend.videoResolution || '768P'),
    duration: Number(backend.videoDuration ?? 5) || 5,
    ratio: String(backend.videoRatio || '16:9'),
    watermark: backend.watermark === true
  }
}

async function videoGenerate(name, backend, { prompt, n }) {
  const key = apiKeyOf(name, backend)
  if (!key) {
    const error = new Error(
      `视频后端还没密钥：在「生图路由」设置页填 ${backend.apiKeyEnv || 'SCNET_API_KEY'}`
    )
    error.status = 400
    throw error
  }

  const count = Math.max(1, Math.min(4, Number(n) || 1))
  const pollMs = Math.max(1000, Number(backend.videoPollMs) || 5000)
  const deadlineAt = Date.now() + Math.max(60_000, Number(backend.videoTimeoutMs) || 600_000)
  const frames = Math.max(1, Math.min(6, Number(backend.videoFrames) || 1))
  const out = []

  for (let index = 0; index < count; index += 1) {
    // 1) 提交任务
    const submit = await fetchJson(`${trimBase(backend)}/videos/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'X-MultiModal-Async': 'true'
      },
      body: JSON.stringify({
        model: backend.model,
        input: { prompt },
        parameters: videoParams(backend)
      })
    })
    if (!submit.response.ok) throw upstreamError(backend.label || '视频后端', submit.response, submit.text, submit.body)
    const taskId = findTaskId(submit.body)
    if (!taskId) {
      throw new Error(`视频后端没有返回 task_id：${submit.text.slice(0, 300)}`)
    }

    // 2) 轮询任务
    let videoUrl
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      const poll = await fetchJson(`${trimBase(backend)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` }
      })
      if (!poll.response.ok) {
        if (poll.response.status === 404) continue
        throw upstreamError(`视频任务 ${taskId}`, poll.response, poll.text, poll.body)
      }
      const status = normalizeTaskStatus(poll.body)
      if (status === 'failed') {
        throw new Error(`视频任务 ${taskId} 失败：${poll.body?.msg ?? poll.body?.message ?? poll.text.slice(0, 300)}`)
      }
      const found = findVideoUrl(poll.body)
      if (found !== undefined) {
        videoUrl = found
        break
      }
      if (status === 'succeeded') {
        throw new Error(`视频任务 ${taskId} 已完成但没有视频地址：${poll.text.slice(0, 300)}`)
      }
      if (Date.now() > deadlineAt) throw new Error(`视频任务 ${taskId} 超时（${pollMs}ms/次轮询）`)
    }

    // 3) 下载 mp4 并落盘，方便用户直接拿去用
    const clip = await rawRequest(videoUrl, { method: 'GET', timeoutMs: 300_000 })
    if (!clip.ok) throw new Error(`下载视频失败（HTTP ${clip.status}）`)
    const bytes = clip.buffer
    ensureVideoDir()
    const saved = path.join(VIDEO_DIR, `scnet-${taskId}.mp4`)
    try {
      fs.writeFileSync(saved, bytes)
    } catch {
      /* 落盘失败不影响出图 */
    }

    // 4) 抽帧回 PNG
    for (let frame = 0; frame < frames; frame += 1) {
      out.push({ b64_json: (await grabFrame(bytes, frame, frames)).toString('base64') })
    }
  }

  return { created: Math.floor(Date.now() / 1000), data: out }
}

/* ------------------------------------------------------------------ *
 * 目标解析
 * ------------------------------------------------------------------ */

/**
 * DSH 传来三种东西，都要能认：
 *   ``（空）→ 当前 active
 *   `img-router/doubao` → 剥前缀
 *   后端名 / 上游模型名 / label 片段
 */
export function resolveTarget(config, modelName) {
  const raw = typeof modelName === 'string' ? modelName.trim() : ''
  const prefix = `${config.routeName || 'img-router'}/`
  const name = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  if (name.length === 0) {
    const backend = config.backends[config.active]
    return backend ? { name: config.active, backend } : undefined
  }
  if (config.backends[name]) return { name, backend: config.backends[name] }
  for (const [key, backend] of Object.entries(config.backends)) {
    if (backend.model === name) return { name: key, backend }
  }
  for (const [key, backend] of Object.entries(config.backends)) {
    if (String(backend.label ?? '').includes(name)) return { name: key, backend }
  }
  return undefined
}

export async function generate(name, backend, params) {
  if (backend.kind === 'ark') return arkGenerate(name, backend, params)
  if (backend.kind === 'video') return videoGenerate(name, backend, params)
  return openaiGenerate(name, backend, params)
}

export async function edit(name, backend, params) {
  if (backend.kind === 'ark') return arkEdit(name, backend, params)
  if (backend.kind === 'video') {
    const error = new Error('视频后端不支持图生图，请换 ark / openai 后端')
    error.status = 400
    throw error
  }
  return openaiEdit(name, backend, params)
}

/* ------------------------------------------------------------------ *
 * 对外状态 / 变更（给设置页用）
 * ------------------------------------------------------------------ */

export function getState() {
  const config = loadConfig()
  const keys = loadKeys()
  return {
    active: config.active,
    routeName: config.routeName || 'img-router',
    configPath: CONFIG_PATH,
    backends: Object.entries(config.backends).map(([name, backend]) => {
      const key = apiKeyOf(name, backend, keys)
      return {
        name,
        label: backend.label ?? name,
        kind: backend.kind ?? 'openai',
        baseURL: backend.baseURL ?? '',
        model: backend.model ?? '',
        apiKeyEnv: backend.apiKeyEnv ?? '',
        // 一定要给字符串：undefined 会让工具输出 schema 判成 "not lossless JSON"，
        // 结果 image_router 每次调用都报 invalid output
        authPrefix: backend.authPrefix === undefined || backend.authPrefix === null ? 'Bearer ' : String(backend.authPrefix),
        stripQuality: backend.stripQuality === true,
        watermark: backend.watermark === true,
        videoResolution: backend.videoResolution ?? '',
        videoDuration: backend.videoDuration ?? '',
        videoRatio: backend.videoRatio ?? '',
        videoFrames: backend.videoFrames ?? '',
        hasKey: key.length > 0,
        keyHint: keyHint(key),
        keyFromPanel: typeof keys[name] === 'string' && keys[name].length > 0,
        isActive: name === config.active,
        modelRef: `${config.routeName || 'img-router'}/${name}`
      }
    })
  }
}

/* ------------------------------------------------------------------ *
 * 把「默认」推给 dsh-model-think-level
 * ------------------------------------------------------------------ */

/**
 * DSH 的 web 端口会变（4875 → 7726 就发生过），所以不写死：
 * 先看环境变量，再依次探几个历史端口，谁先答 `/dsh-model-think-level/image-config` 就是它。
 */
const DSH_PORTS = [
  Number(process.env.DSH_WEB_PORT || 0),
  12871,
  7726,
  4875,
  4876,
  4877,
  4886,
  4887,
  4888
].filter((port) => Number.isInteger(port) && port > 0)

let cachedDshPort = 0

/**
 * 由 Host 半侧在拿到 `webServer.getOrigin()` 时注入。
 *
 * 猜端口是不可靠的：DSH 的 web 端口每次都换（4875 → 7726 → 12871 → 1919 都见过），
 * 而且可能落在任何区间。插件自己的 webServer 服务知道确切地址，直接用它的。
 */
let dshOrigin = ''

export function setDshOrigin(origin) {
  const value = String(origin ?? '').trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(value)) dshOrigin = value
}

export function getDshOrigin() {
  return dshOrigin
}

const PORT_CACHE_PATH = path.join(STATE_DIR, 'dsh-port.json')

function readPortCache() {
  try {
    const value = JSON.parse(fs.readFileSync(PORT_CACHE_PATH, 'utf8'))
    return Number.isInteger(value?.port) ? value.port : 0
  } catch {
    return 0
  }
}

function writePortCache(port) {
  try {
    ensureDir()
    fs.writeFileSync(PORT_CACHE_PATH, JSON.stringify({ port, at: Date.now() }), 'utf8')
  } catch {
    /* 缓存写不进去不影响功能 */
  }
}

async function probePort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/dsh-model-think-level/image-config`, {
      signal: AbortSignal.timeout(1200)
    })
    return response.ok ? port : 0
  } catch {
    return 0
  }
}

/**
 * DSH 的 web 端口每次启动都可能换一个（4875 → 7726 → 12871 都见过），
 * 所以按三层找：缓存 → 已知端口 → 扫一段本地端口。找到就记住。
 */
async function findDshPort() {
  if (dshOrigin) {
    const port = Number(new URL(dshOrigin).port || 0)
    if (port > 0) return port
  }
  if (cachedDshPort) return cachedDshPort

  const cached = readPortCache()
  if (cached && (await probePort(cached))) {
    cachedDshPort = cached
    return cached
  }

  for (const port of DSH_PORTS) {
    if (await probePort(port)) {
      cachedDshPort = port
      writePortCache(port)
      return port
    }
  }

  // 兜底：DSH web 端口落在 3000-20000 的临时端口段，扫一遍（分批并发，别把连接打满）
  const candidates = []
  for (let port = 1000; port <= 20000; port += 1) {
    if (!DSH_PORTS.includes(port)) candidates.push(port)
  }
  const BATCH = 400
  for (let offset = 0; offset < candidates.length; offset += BATCH) {
    const batch = candidates.slice(offset, offset + BATCH)
    const hits = await Promise.all(batch.map((port) => probePort(port)))
    const found = hits.find((port) => port > 0)
    if (found) {
      cachedDshPort = found
      writePortCache(found)
      return found
    }
  }
  return 0
}

/** 拿到 DSH web 的基址：优先 Host 注入的 origin，其次找到的端口。 */
export async function dshBaseUrl() {
  if (dshOrigin) return dshOrigin
  const port = await findDshPort()
  return port > 0 ? `http://127.0.0.1:${port}` : ''
}

/**
 * 让 generate_image 不写 model 时走我们选中的后端。
 *
 * 不做这件事的话：面板上切了 doubao，DSH 那边仍按 `img-router/local` 发请求，
 * 切了等于没切 —— 这是最容易被当成「插件没用」的失败模式，所以必须联动。
 */
export async function pushDshDefault(backendName) {
  const base = await dshBaseUrl()
  if (!base) return { ok: false, error: '找不到 DSH 的 web 地址，未同步默认模型' }
  const config = loadConfig()
  const modelRef = `${config.routeName || 'img-router'}/${backendName}`
  try {
    const response = await fetch(`${base}/dsh-model-think-level/image-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: modelRef }),
      signal: AbortSignal.timeout(5000)
    })
    const text = await response.text()
    if (!response.ok) {
      cachedDshPort = 0
      return { ok: false, status: response.status, error: text.slice(0, 300) }
    }
    return { ok: true, status: response.status, modelRef }
  } catch (error) {
    cachedDshPort = 0
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 切换默认后端。
 *
 * 同步推 DSH 的 defaultModel；推失败不算切换失败（后端已经存下来了），
 * 但结果里带上原因，面板能显示「本地已切，DSH 没同步」。
 */
export async function setActive(name) {
  const config = loadConfig()
  if (!config.backends[name]) throw new Error(`未知后端：${name}`)
  config.active = name
  saveConfig(config)
  const dsh = await pushDshDefault(name)
  return { active: name, dsh }
}

export function setKey(name, key) {
  const config = loadConfig()
  if (!config.backends[name]) throw new Error(`未知后端：${name}`)
  const keys = loadKeys()
  const value = String(key ?? '').trim()
  if (value.length === 0) delete keys[name]
  else keys[name] = value
  saveKeys(keys)
  return { ok: true }
}

const BACKEND_FIELDS = [
  'label',
  'kind',
  'baseURL',
  'model',
  'apiKeyEnv',
  'authPrefix',
  'stripQuality',
  'watermark',
  'sizeFallback',
  'videoResolution',
  'videoDuration',
  'videoRatio',
  'videoFrames',
  'videoPollMs',
  'videoTimeoutMs'
]

/** 新增或修改一个后端。name 只能是小写字母数字下划线连字符，避免和路由名打架。 */
export function upsertBackend(name, spec) {
  const config = loadConfig()
  const id = String(name ?? '').trim()
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error('后端名只能用字母、数字、下划线、连字符（1-32 位）')
  // 重建同名后端时把它从 removed 里摘出来
  if (Array.isArray(config.removed) && config.removed.includes(id)) {
    config.removed = config.removed.filter((item) => item !== id)
  }
  const next = { ...(config.backends[id] ?? {}), label: id }
  for (const field of BACKEND_FIELDS) {
    if (spec && Object.prototype.hasOwnProperty.call(spec, field)) next[field] = spec[field]
  }
  if (!next.baseURL) throw new Error('baseURL 必填')
  if (!next.model) throw new Error('模型 ID 必填')
  if (next.kind !== 'ark' && next.kind !== 'video') next.kind = 'openai'
  config.backends[id] = next
  saveConfig(config)
  if (spec && typeof spec.key === 'string' && spec.key.trim().length > 0) setKey(id, spec.key)
  return getState()
}

export function removeBackend(name) {
  const config = loadConfig()
  if (!config.backends[name]) throw new Error(`未知后端：${name}`)
  if (Object.keys(config.backends).length <= 1) throw new Error('至少留一个后端')
  delete config.backends[name]
  // 内置后端也要能删：记进 removed，否则 loadConfig 会把 defaultConfig 里的同名项合并回来
  if (Object.prototype.hasOwnProperty.call(defaultConfig().backends, name)) {
    const removed = new Set(Array.isArray(config.removed) ? config.removed : [])
    removed.add(name)
    config.removed = [...removed]
  }
  if (config.active === name) config.active = Object.keys(config.backends)[0]
  saveConfig(config)
  const keys = loadKeys()
  delete keys[name]
  saveKeys(keys)
  return getState()
}

/** 读 DSH 那边的生图默认模型（img-router/<后端>） */
export async function getDshDefault() {
  const base = await dshBaseUrl()
  if (!base) return { ok: false, error: '找不到 DSH 的 web 地址' }
  try {
    const response = await fetch(`${base}/dsh-model-think-level/image-config`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) return { ok: false, status: response.status, error: (await response.text()).slice(0, 300) }
    const payload = await response.json()
    return { ok: true, defaultModel: payload.defaultModel ?? null }
  } catch (error) {
    cachedDshPort = 0
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 后端名列表 + 每个后端的展示名，供「同步 DSH 模型行」使用。
 * 模型行写在 provider 配置里，只有插件自己知道该长什么样，所以这里集中给出。
 */
export function dshModelRows() {
  const config = loadConfig()
  const routeName = config.routeName || 'img-router'
  return Object.entries(config.backends).map(([name, backend]) => ({
    name,
    routeName,
    modelRef: `${routeName}/${name}`,
    row: {
      inputImageGen: true,
      id: name,
      name: backend.label || name,
      contextWindow: 4096,
      maxTokens: 2048,
      reasoningEfforts: false,
      reasoningEffortsAutofilled: 0
    }
  }))
}

/** 真跑一张最小图，验证 key / 地址 / 模型名是否都对 */
export async function testBackend(name) {
  const config = loadConfig()
  const backend = config.backends[name]
  if (!backend) throw new Error(`未知后端：${name}`)
  const startedAt = Date.now()
  // 视频后端跑一整条任务要几分钟且吃配额，这里只验鉴权和端点可达
  if (backend.kind === 'video') {
    try {
      const key = apiKeyOf(name, backend)
      if (!key) return { ok: false, ms: 0, error: `还没密钥：填 ${backend.apiKeyEnv || 'SCNET_API_KEY'}` }
      const probe = await fetchJson(`${trimBase(backend)}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` }
      })
      if (!probe.response.ok) throw upstreamError(backend.label || '视频后端', probe.response, probe.text, probe.body)
      const known = (probe.body?.data ?? []).some((row) => row?.id === backend.model)
      return {
        ok: true,
        ms: Date.now() - startedAt,
        images: 0,
        note: known
          ? `鉴权通过，${backend.model} 在模型列表里；实际出片走 generate_image（约 1-3 分钟）`
          : `鉴权通过，但模型列表里没有 ${backend.model}（可能是不在 /models 里列出的异步模型）`
      }
    } catch (error) {
      return { ok: false, ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const result = await generate(name, backend, {
      prompt: 'a red apple on a wooden table, product photo',
      size: '1024x1024',
      n: 1,
      quality: 'medium'
    })
    return { ok: true, ms: Date.now() - startedAt, images: result.data.length }
  } catch (error) {
    return { ok: false, ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }
  }
}

