import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from './server/db';
import { createSession } from './server/auth';
import { NextResponse } from 'next/server';
type Provider = 'google' | 'kakao' | 'naver' | 'apple';
const specs = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    user: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile',
  },
  kakao: {
    authorize: 'https://kauth.kakao.com/oauth/authorize',
    token: 'https://kauth.kakao.com/oauth/token',
    user: 'https://kapi.kakao.com/v2/user/me',
    scope: 'profile_nickname',
  },
  naver: {
    authorize: 'https://nid.naver.com/oauth2.0/authorize',
    token: 'https://nid.naver.com/oauth2.0/token',
    user: 'https://openapi.naver.com/v1/nid/me',
    scope: '',
  },
  apple: {
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    user: '',
    scope: 'name',
  },
};
interface LoginState {
  state: string;
  verifier: string;
  nonce: string;
  role: 'STUDENT' | 'PARENT';
  provider: Provider;
  expires: number;
}
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
export function configuredProviders() {
  return (Object.keys(specs) as Provider[]).filter((p) =>
    Boolean(
      process.env[`${p.toUpperCase()}_CLIENT_ID`] &&
      process.env[`${p.toUpperCase()}_CLIENT_SECRET`] &&
      process.env.AUTH_SECRET &&
      process.env.APP_URL,
    ),
  );
}
function sign(text: string) {
  return createHmac('sha256', process.env.AUTH_SECRET!).update(text).digest('base64url');
}
function pack(value: LoginState) {
  const text = Buffer.from(JSON.stringify(value)).toString('base64url');
  return text + '.' + sign(text);
}
function unpack(value: string | undefined): LoginState | null {
  if (!value) return null;
  try {
    const [text, signature] = value.split('.');
    const actual = Buffer.from(sign(text));
    const expected = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const decoded = JSON.parse(Buffer.from(text, 'base64url').toString());
    return decoded.expires > Date.now() ? decoded : null;
  } catch {
    return null;
  }
}
function transientCookie(value: string, provider: Provider, clear = false) {
  const secure = process.env.APP_URL?.startsWith('https:');
  return `memoryz_oauth=${value}; Path=/api/auth; HttpOnly; SameSite=${provider === 'apple' && secure ? 'None' : 'Lax'}; Max-Age=${clear ? 0 : 600}${secure ? '; Secure' : ''}`;
}
export async function oauth(request: Request, providerName: string, steps: string[] = []) {
  if (!(providerName in specs) || !configuredProviders().includes(providerName as Provider))
    return Response.json({ error: '이 로그인 서비스가 아직 연결되지 않았어요.' }, { status: 503 });
  const provider = providerName as Provider;
  const spec = specs[provider];
  const origin = new URL(process.env.APP_URL!).origin;
  const redirectUri = `${origin}/api/auth/${provider}/callback`;
  const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`]!;
  const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`]!;
  if (steps.length === 0 && request.method === 'GET') {
    const reqUrl = new URL(request.url);
    const state: LoginState = {
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      nonce: randomBytes(24).toString('base64url'),
      role: reqUrl.searchParams.get('role') === 'PARENT' ? 'PARENT' : 'STUDENT',
      provider,
      expires: Date.now() + 600000,
    };
    const url = new URL(spec.authorize);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: state.state,
      ...(spec.scope ? { scope: spec.scope } : {}),
      ...(provider === 'google'
        ? {
            nonce: state.nonce,
            code_challenge: createHash('sha256').update(state.verifier).digest('base64url'),
            code_challenge_method: 'S256',
          }
        : {}),
      ...(provider === 'apple' ? { nonce: state.nonce, response_mode: 'form_post' } : {}),
    }).toString();
    const response = NextResponse.redirect(url);
    response.headers.append('Set-Cookie', transientCookie(pack(state), provider));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
  if (steps.length !== 1 || steps[0] !== 'callback')
    return Response.json({ error: '잘못된 로그인 경로예요.' }, { status: 404 });
  let result: NextResponse;
  try {
    const incoming =
      request.method === 'POST'
        ? new URLSearchParams(await request.text())
        : new URL(request.url).searchParams;
    const raw = request.headers
      .get('cookie')
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('memoryz_oauth='))
      ?.slice(14);
    const state = unpack(raw);
    const code = incoming.get('code');
    if (!state || state.provider !== provider || incoming.get('state') !== state.state || !code)
      throw new Error('invalid-state');
    const tokenResponse = await fetch(spec.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        state: state.state,
        ...(provider === 'google' ? { code_verifier: state.verifier } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!tokenResponse.ok) throw new Error('token-exchange');
    const token = await tokenResponse.json();
    let providerId: string;
    let name = '새로운 기억';
    if (provider === 'apple') {
      const verified = await jwtVerify(token.id_token, appleKeys, {
        issuer: 'https://appleid.apple.com',
        audience: clientId,
        algorithms: ['RS256'],
      });
      if (verified.payload.nonce !== state.nonce || !verified.payload.sub)
        throw new Error('invalid-nonce');
      providerId = verified.payload.sub;
      const userJson = incoming.get('user');
      if (userJson) {
        try {
          const detail = JSON.parse(userJson);
          name = [detail.name?.lastName, detail.name?.firstName].filter(Boolean).join(' ') || name;
        } catch {}
      }
    } else {
      if (!token.access_token) throw new Error('missing-token');
      const infoResponse = await fetch(spec.user, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!infoResponse.ok) throw new Error('userinfo');
      const info = await infoResponse.json();
      providerId = String(
        provider === 'google' ? info.sub : provider === 'kakao' ? info.id : info.response?.id,
      );
      name = String(
        provider === 'google'
          ? (info.name ?? name)
          : provider === 'kakao'
            ? (info.properties?.nickname ?? name)
            : (info.response?.nickname ?? name),
      );
    }
    if (!providerId || providerId === 'undefined') throw new Error('invalid-identity');
    let account = await db.oAuthAccount.findUnique({
      where: { provider_providerId: { provider, providerId } },
      include: { user: true },
    });
    let created = false;
    if (!account) {
      created = true;
      account = await db.oAuthAccount.create({
        data: {
          provider,
          providerId,
          user: {
            create: {
              name: name.slice(0, 50),
              nickname: `기억${randomBytes(6).toString('hex')}`,
              role: state.role,
            },
          },
        },
        include: { user: true },
      });
    }
    if (account.user.suspended) throw new Error('suspended');
    result = NextResponse.redirect(
      new URL(created ? '/onboarding' : account.user.role === 'PARENT' ? '/parent' : '/', origin),
      303,
    );
    result.headers.append('Set-Cookie', await createSession(account.userId, new Request(origin)));
  } catch {
    result = NextResponse.redirect(new URL('/?loginError=1', origin), 303);
  }
  result.headers.append('Set-Cookie', transientCookie('', provider, true));
  result.headers.set('Cache-Control', 'no-store');
  return result;
}
