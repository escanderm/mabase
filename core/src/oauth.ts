// Провайдеры OAuth2 (design.md §11): authorization code + PKCE, код меняет
// сервер. Провайдер - маленькое описание: адреса, scopes, чтение профиля.
// Apple - тем же способом, когда понадобится.

export type OAuthProfile = {
  id: string // id у провайдера
  email?: string
  emailVerified: boolean // провайдер подтвердил, что адрес принадлежит человеку
  name?: string
  avatar?: string
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export type OAuthTokenContext = { clientId: string; body: any }

export type OAuthTokenArgs = {
  code: string
  redirectUri: string
  verifier: string
  extra: Record<string, string> // прочие query-параметры возврата (VK: device_id)
}

export type OAuthProvider = {
  authUrl: string
  tokenUrl: string
  scopes: string[]
  // PKCE: по умолчанию включён (Google, GitHub, Яндекс, VK ID его поддерживают)
  pkce?: boolean
  // нужен ли client secret: публичному приложению VK ID - нет
  secret?: boolean
  // имя параметра для секрета: у VK это service_token (конфиденциальное приложение)
  secretParam?: string
  // передавать ли redirect_uri при обмене кода (Яндекс его не требует)
  redirectUriInToken?: boolean
  // доп. параметры обмена из возврата (VK: device_id)
  extraToken?: (extra: Record<string, string>) => Record<string, string>
  profile: (accessToken: string, fetch: Fetch, signal: AbortSignal, ctx: OAuthTokenContext) => Promise<OAuthProfile>
}

export type OAuthClient = { clientId: string; clientSecret: string }

async function getJson(fetch: Fetch, url: string, accessToken: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...headers }, signal })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

// GitHub требует User-Agent у API.
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'MaBase' }

export const OAUTH_PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile'],
    profile: async (token, fetch, signal) => {
      const p = await getJson(fetch, 'https://openidconnect.googleapis.com/v1/userinfo', token, signal)
      if (!str(p.sub)) throw new Error('google: в профиле нет sub')
      return { id: p.sub, email: str(p.email), emailVerified: p.email_verified === true, name: str(p.name), avatar: str(p.picture) }
    },
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'user:email'],
    profile: async (token, fetch, signal) => {
      const p = await getJson(fetch, 'https://api.github.com/user', token, signal, GITHUB_HEADERS)
      if (typeof p.id !== 'number' && !str(p.id)) throw new Error('github: в профиле нет id')
      // email из профиля может быть неподтверждённым или скрытым - берём основной из /user/emails
      const emails: any[] = await getJson(fetch, 'https://api.github.com/user/emails', token, signal, GITHUB_HEADERS)
      const primary = Array.isArray(emails) ? emails.find((e) => e?.primary) : undefined
      return {
        id: String(p.id),
        email: str(primary?.email),
        emailVerified: primary?.verified === true,
        name: str(p.name) ?? str(p.login),
        avatar: str(p.avatar_url),
      }
    },
  },
  // Яндекс ID: обычный code-flow, профиль - login.yandex.ru по заголовку OAuth.
  yandex: {
    authUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    scopes: ['login:email', 'login:info'],
    redirectUriInToken: false, // Яндекс не ждёт redirect_uri при обмене
    profile: async (token, fetch, signal) => {
      const res = await fetch('https://login.yandex.ru/info?format=json', { headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' }, signal })
      if (!res.ok) throw new Error(`яндекс: профиль ${res.status}`)
      const p: any = await res.json()
      if (p?.id === undefined || p?.id === null || p.id === '') throw new Error('яндекс: в профиле нет id')
      const email = str(p.default_email) ?? (Array.isArray(p.emails) ? str(p.emails[0]) : undefined)
      const avatar = p.is_avatar_empty === false && str(p.default_avatar_id) ? `https://avatars.yandex.net/get-yapic/${p.default_avatar_id}/islands-200` : undefined
      // default_email у Яндекса - адрес аккаунта, он подтверждён
      return { id: String(p.id), email, emailVerified: !!email, name: str(p.real_name) ?? str(p.display_name), avatar }
    },
  },
  // VK ID: PKCE обязателен, в возврате приходит device_id, профиль - POST user_info.
  vk: {
    authUrl: 'https://id.vk.ru/authorize',
    tokenUrl: 'https://id.vk.ru/oauth2/auth',
    scopes: ['email'],
    secret: false, // публичному приложению VK ID секрет не нужен
    secretParam: 'service_token', // если задан - уйдёт как service_token
    extraToken: (extra) => (extra.device_id ? { device_id: extra.device_id } : {} as Record<string, string>),
    profile: async (token, fetch, signal, ctx) => {
      const res = await fetch('https://id.vk.ru/oauth2/user_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ access_token: token, client_id: ctx.clientId }).toString(),
        signal,
      })
      if (!res.ok) throw new Error(`vk: профиль ${res.status}`)
      const j: any = await res.json().catch(() => null)
      const u = j?.user ?? j
      // user_id у VK - число, поэтому не str(): принимаем и число, и строку
      const idNum = u?.user_id ?? ctx.body?.user_id
      const id = idNum === undefined || idNum === null || idNum === '' ? undefined : String(idNum)
      if (!id) throw new Error('vk: в профиле нет user_id')
      const name = [str(u?.first_name), str(u?.last_name)].filter(Boolean).join(' ')
      const email = str(u?.email)
      return { id, email, emailVerified: !!email, name: name || undefined, avatar: str(u?.avatar) }
    },
  },
} satisfies Record<string, OAuthProvider>

export type OAuthProviderName = keyof typeof OAUTH_PROVIDERS

// Обменять код на токен провайдера. Секрет и PKCE-ключ знает только сервер.
export async function exchangeCode(
  provider: OAuthProvider,
  client: OAuthClient,
  args: OAuthTokenArgs,
  fetch: Fetch,
  signal: AbortSignal,
): Promise<{ accessToken: string; body: any }> {
  const form: Record<string, string> = { grant_type: 'authorization_code', code: args.code, client_id: client.clientId }
  if (provider.redirectUriInToken !== false) form.redirect_uri = args.redirectUri
  if (provider.secret !== false) form[provider.secretParam ?? 'client_secret'] = client.clientSecret
  else if (client.clientSecret) form[provider.secretParam ?? 'client_secret'] = client.clientSecret // VK: service_token, если задан
  if (provider.pkce !== false) form.code_verifier = args.verifier
  Object.assign(form, provider.extraToken?.(args.extra ?? {}) ?? {})
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal,
  })
  const body: any = await res.json().catch(() => null)
  // GitHub отвечает 200 и { error } при неверном коде
  if (!res.ok || !body || typeof body.access_token !== 'string') throw new Error(`обмен кода: ${res.status} ${body?.error ?? ''}`)
  return { accessToken: body.access_token, body }
}
