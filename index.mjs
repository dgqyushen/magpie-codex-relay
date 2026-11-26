// Codex Relay — 复用 magpie 里 ChatGPT 订阅的 Codex 登录，把请求改道到
// 第三方 Codex 网关（openai_base_url 那一类中转站）。
//
// 边界（故意画死）：
//   * 只读 Codex 自己的登录态（$CODEX_HOME/auth.json，容器里是
//     /config/.codex/auth.json），**只借 access token**；
//   * 绝不刷新、绝不改写这个文件：refresh token 由 magpie 的内置 Codex
//     账号和 Codex CLI 自己轮换，插件插手会撞上它们的锁（codexMu）并把
//     一次性的 refresh token 提前花掉；
//   * 只换上游地址，请求体、头、流式响应原样转发；不翻译协议。
//
// 因此 magpie 里内置的 codex 订阅照常工作，本插件是并列的一个 provider：
// codex-relay/<model>。两边用同一份登录、同一个账号，互不影响。
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { homedir } from "node:os"

const ID = "codex-relay"
const NPM = "@ai-sdk/openai" // Responses 协议：magpie 只做协议翻译，不自己发请求
const DEFAULT_BASE = "https://codex-relay.oaifree.com/backend-api/codex"
// 上游按 version 头卡能力：太老会被 400 "requires a newer version of Codex"。
// 这是插件自己的声明，与 magpie 内置 Codex 的版本号无关。
const DEFAULT_VERSION = "0.172.0"
const ACCOUNT = ID // 这个 provider 只有一个账号：官方那份登录

// ---- 读官方登录 -------------------------------------------------------------

// codexHomes 是 Codex 可能放着 auth.json 的目录，顺序即优先级：
// $CODEX_HOME（magpie 认的那个，容器里没设）→ ~/.codex →
// ~ 下和 ~/.codex 旁边以 codex 开头的目录（多账号用户用 CODEX_HOME 分目录）。
function codexHomes() {
  const home = process.env.HOME || homedir()
  const out = []
  const add = (d) => {
    if (d && isAbsolute(d) && !out.includes(d)) out.push(d)
  }
  const env = (process.env.CODEX_HOME || "").trim()
  if (env && isAbsolute(env)) add(env)
  add(join(home, ".codex"))
  for (const root of [home]) {
    let names = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/^\.?codex/i.test(name)) continue
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      if (existsSync(join(dir, "auth.json"))) add(dir)
    }
  }
  return out
}

// readLogin 读一份 auth.json。返回 null 表示这个目录没有可用的 ChatGPT 登录。
// auth_mode 为 apikey 的不算：那是 Codex 的 API key 模式，没有订阅 token。
function readLogin(dir) {
  let raw
  try {
    raw = readFileSync(join(dir, "auth.json"), "utf8")
  } catch {
    return null
  }
  let a
  try {
    a = JSON.parse(raw)
  } catch {
    return null
  }
  const tokens = a?.tokens
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) return null
  if (a.auth_mode === "apikey") return null
  return {
    dir,
    access: tokens.access_token,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : "",
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : "",
  }
}

// jwtPayload 解出 JWT 的 payload，不验签：只读 exp 和邮箱。
function jwtPayload(tok) {
  const parts = String(tok || "").split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return null
  }
}

// loginUser 是账号显示名：与 magpie 内置 Codex 读同一份 id_token，
// 所以两边在 UI 里显示的是同一个邮箱。
function loginUser(l) {
  const p = jwtPayload(l.idToken)
  const email = p?.email || p?.["https://api.openai.com/profile"]?.email || ""
  return typeof email === "string" && email ? email : l.accountId || "ChatGPT"
}

// loginPlan 是订阅档位（plus / pro / team …），同样来自 id_token。
function loginPlan(l) {
  const p = jwtPayload(l.idToken)
  const plan = p?.["https://api.openai.com/auth"]?.chatgpt_plan_type
  return typeof plan === "string" ? plan : ""
}

// accessExpired 说 access token 是否已经过期。插件不刷新，所以过期就是
// 过期：让上游回 401，由用户重登（magpie 的内置 codex 会自己续上，
// 插件下次读到的是新 token）。
function accessExpired(l, skewMs = 60_000) {
  const p = jwtPayload(l.access)
  const exp = Number(p?.exp)
  return Number.isFinite(exp) && exp > 0 && Date.now() + skewMs >= exp * 1000
}

// currentLogin 是当前要用的那份登录：第一份未过期的，否则第一份存在的。
function currentLogin() {
  const logins = codexHomes().map(readLogin).filter(Boolean)
  return logins.find((l) => !accessExpired(l)) ?? logins[0] ?? null
}

// ---- 选项 -------------------------------------------------------------------

// 选项从插件函数第二个参数（plugins.json 的 options）读，不是 auth.options：
// 后者是 magpie 的布尔开关，`magpie.option()` 只返回 true/false，
// 字符串配置放进去会被读成 false。
// 设置：magpie plugin options codex-relay '{"baseURL":"https://…"}'
function option(options, key, fallback) {
  const v = options?.[key]
  if (typeof v === "string" && v.trim()) return v.trim()
  return fallback
}

// upstreamBase 是配置的上游网关地址，规整成不带尾斜杠的形式。
// 允许用户填到 /backend-api/codex，也允许填到更外层。
function upstreamBase(options) {
  const raw = option(options, "baseURL", DEFAULT_BASE)
  const s = String(raw).trim().replace(/\/+$/, "")
  return s || DEFAULT_BASE
}

function codexVersion(options) {
  const v = option(options, "codexVersion", DEFAULT_VERSION)
  return /^\d+\.\d+\.\d+$/.test(String(v)) ? String(v) : DEFAULT_VERSION
}

// ---- 转发 -------------------------------------------------------------------

// 上游只认它自己的路径：base 之后接 /responses、/models、/wham/usage …
// magpie 交给插件 fetch 的地址已经按 loader 的 baseURL 拼好（base + /responses），
// 所以这里要判断：已经以 base 开头的原样用，只有 plugin:// 或别的 host 才重拼。
function targetURL(base, url) {
  const s = String(url ?? "")
  // 已经拼在 base 上：原样
  if (s === base || s.startsWith(base + "/") || s.startsWith(base + "?")) return s
  let rest = ""
  try {
    const u = new URL(s)
    // plugin://<id>/v1/responses → /v1/responses；别的 host 只取路径
    rest = u.pathname + u.search
  } catch {
    rest = s
  }
  rest = rest.replace(/^\/+/, "/")
  // AI SDK 的 base 到 /v1 为止，上游不需要它
  if (rest.startsWith("/v1/")) rest = rest.slice(3)
  else if (rest === "/v1") rest = ""
  return base + rest
}

// headers 是转发用的头：去掉调用方可能带来的凭据与 hop-by-hop 头，
// 换成官方登录的 Bearer，再补上 Codex 自己的客户端标识（上游靠它放行模型）。
function headers(reqHeaders, login, version) {
  const h = new Headers(reqHeaders ?? {})
  for (const name of [
    "authorization",
    "x-api-key",
    "cookie",
    "proxy-authorization",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "keep-alive",
    "proxy-connection",
    "accept-encoding",
  ]) {
    h.delete(name)
  }
  for (const name of [...h.keys()]) if (name.toLowerCase().startsWith("x-magpie-")) h.delete(name)
  h.set("Authorization", "Bearer " + login.access)
  if (login.accountId) h.set("chatgpt-account-id", login.accountId)
  h.set("OpenAI-Beta", "responses=experimental")
  h.set("originator", "codex_cli_rs")
  h.set("version", version)
  h.set("User-Agent", "codex_cli_rs/" + version)
  return h
}

export async function CodexRelayPlugin(input, options = {}) {
  const base = () => upstreamBase(options)
  const version = () => codexVersion(options)

  // listModels 问上游要模型目录。magpie 的 models 钩子拿到的是账号目录，
  // 这里按 Codex 自己的 /models 形状转成插件模型。
  async function listModels(signal) {
    const login = currentLogin()
    if (!login) throw Object.assign(new Error("magpie 里还没有 ChatGPT 的 Codex 登录：先在 magpie 里登录 Codex 订阅"), { signIn: "expired" })
    const url = base() + "/models?client_version=" + encodeURIComponent(version())
    const res = await fetch(url, {
      headers: headers({}, login, version()),
      signal,
      redirect: "error",
    })
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error("上游拒绝了这份 Codex 登录（HTTP " + res.status + "）"), { signIn: "expired" })
    }
    if (!res.ok) throw new Error("上游模型列表读不到（HTTP " + res.status + "）")
    const body = await res.json().catch(() => null)
    const list = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : null
    if (!list) throw new Error("上游模型列表格式不认识")
    const out = {}
    for (const m of list) {
      const id = typeof m?.slug === "string" ? m.slug : typeof m?.id === "string" ? m.id : ""
      if (!id) continue
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((x) => (typeof x === "string" ? x : x?.effort)).filter((x) => typeof x === "string" && x)
        : []
      const images = Array.isArray(m.input_modalities) && m.input_modalities.includes("image")
      const context = Number(m.context_window) || 0
      const output = Number(m.max_output_tokens) || 0
      out[id] = {
        id,
        name: typeof m.display_name === "string" && m.display_name ? m.display_name : id,
        npm: NPM,
        url: base(),
        limit: { context, output },
        capabilities: {
          temperature: false,
          reasoning: levels.length > 0,
          attachment: images,
          toolcall: true,
          input: { text: true, image: images, audio: false, video: false, pdf: false },
          output: { text: true, image: false, audio: false, video: false, pdf: false },
          interleaved: false,
        },
        variants: levels.length ? Object.fromEntries(levels.map((l) => [l, {}])) : {},
      }
    }
    return out
  }

  return {
    // config 声明 provider。api 是 npm 的默认地址，真正的上游在 loader 的 fetch 里。
    config(config) {
      config.provider ??= {}
      const p = (config.provider[ID] ??= {})
      p.name ??= "Codex Relay"
      p.npm ??= NPM
      p.api ??= base()
      p.models ??= {}
    },

    provider: {
      id: ID,
      // models 是账号的模型目录：向上游的 Codex /models 要一次，
      // 转成插件模型表。magpie 会缓存这份目录，并据它生成模型选择器。
      // 读不到就抛出，magpie 会保留上一次的目录并标记原因。
      async models(provider, ctx) {
        const listed = await listModels(ctx?.signal)
        return { ...(provider.models ?? {}), ...listed }
      },
    },

    auth: {
      provider: ID,
      // 不声明 refresh / rotating：插件不参与 token 续期，只借一次。
      // keepAlive 也就无从谈起，magpie 不会为它排后台续期。
      keepAlive: false,
      // 唯一的登录方式是"用 magpie 里已有的 Codex 登录"，无输入、无跳转。
      methods: [
        {
          type: "api",
          label: "使用 magpie 里的 Codex 登录",
          keyless: true,
          async authorize() {
            const login = currentLogin()
            if (!login) {
              return { type: "failed", error: "magpie 里还没有 ChatGPT 的 Codex 登录：先在 magpie 里登录 Codex 订阅，再回到这里" }
            }
            return {
              type: "success",
              key: "codex-login",
              metadata: { email: loginUser(login), dir: login.dir },
            }
          },
        },
      ],
      // loader 给出上游地址与签名后的 fetch。这里返回的 fetch 是唯一
      // 能改地址和头的地方，magpie 不会绕过它。
      async loader() {
        const login = currentLogin()
        if (!login) return {}
        return {
          baseURL: base(),
          apiKey: "codex-relay",
          async fetch(url, init) {
            // 每次请求都重读登录：magpie 的内置 codex 会在后台续期，
            // 插件这边就能拿到续期后的新 token，而不必自己刷新。
            const cur = currentLogin() ?? login
            const target = targetURL(base(), url)
            const res = await fetch(target, {
              ...init,
              headers: headers(init?.headers, cur, version()),
              redirect: "error",
            })
            // 让上游的压缩编码和长度按实际重算：body 被 fetch 解开了
            const out = new Headers(res.headers)
            out.delete("content-encoding")
            out.delete("content-length")
            // 401/403 如实告诉 magpie 这份登录被拒了，由它标记账号，
            // 而不是让插件假装成别的错误
            if (res.status === 401 || res.status === 403) out.set("X-Magpie-Sign-In", "expired")
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
          },
        }
      },
    },
  }
}

// magpie 在 host 里直接调用插件函数；OpenCode 侧不需要这个包，
// 但导出形状保持一致，避免宿主按 exports 规则误判。
export default { id: "@magpie-community/opencode-codex-relay-auth", server: CodexRelayPlugin }
