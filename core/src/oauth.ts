// Провайдеры OAuth2 (design.md §11): authorization code + PKCE, код меняет
// сервер. Провайдер - маленькое описание: адреса, scopes, чтение профиля.
// Яндекс, VK, Apple - тем же способом, когда понадобятся.

export type OAuthProfile = {
  id: string // id у провайдера
  email?: string
  emailVerified: boolean // провайдер подтвердил, что адрес принадлежит человеку
  name?: string
  avatar?: string
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export type OAuthProvider = {
  authUrl: string
  tokenUrl: string
  scopes: string[]
  profile: (accessToken: string, fetch: Fetch, signal: AbortSignal) => Promise<OAuthProfile>
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
} satisfies Record<string, OAuthProvider>

export type OAuthProviderName = keyof typeof OAUTH_PROVIDERS

// Обменять код на токен провайдера. Секрет и PKCE-ключ знает только сервер.
export async function exchangeCode(
  provider: OAuthProvider,
  client: OAuthClient,
  args: { code: string; redirectUri: string; verifier: string },
  fetch: Fetch,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: args.verifier,
    }).toString(),
    signal,
  })
  const body: any = await res.json().catch(() => null)
  // GitHub отвечает 200 и { error } при неверном коде
  if (!res.ok || !body || typeof body.access_token !== 'string') throw new Error(`обмен кода: ${res.status} ${body?.error ?? ''}`)
  return body.access_token
}
