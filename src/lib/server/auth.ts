import { randomBytes, createHash } from 'node:crypto';
import { db } from './db';
import { ApiError } from './errors';
import type { User } from './generated/client';

export const SESSION_COOKIE = 'memoryz_session';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function readSessionToken(request: Request) {
  return request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length+1);
}
export async function currentUser(request: Request): Promise<User> {
  const token = readSessionToken(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401,'로그인이 필요해요.');
  const session = await db.session.findUnique({where:{id:tokenHash(token)},include:{user:true}});
  if (!session || session.expiresAt <= new Date()) throw new ApiError(401,'세션이 만료됐어요. 다시 로그인해 주세요.');
  if (session.user.suspended) throw new ApiError(403,'이용이 제한된 계정이에요.');
  return session.user;
}
export async function createSession(userId: string, request: Request) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now()+7*24*60*60*1000);
  await db.session.create({data:{id:tokenHash(token),userId,expiresAt}});
  await db.session.deleteMany({where:{userId,expiresAt:{lt:new Date()}}});
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${new URL(request.url).protocol==='https:'||process.env.APP_URL?.startsWith('https:')?'; Secure':''}`;
}
export function requireRole(user: User, ...roles: string[]) {
  if (!roles.includes(user.role)) throw new ApiError(403,'이 계정으로 접근할 수 없는 기능이에요.');
}
export function protectMutation(request: Request) {
  if (request.method==='GET'||request.method==='HEAD') return;
  const origin = request.headers.get('origin');
  const appOrigin=process.env.APP_URL?new URL(process.env.APP_URL).origin:process.env.APP_ORIGIN;
  let matchesRequestHost=false;
  if(origin){try{const originUrl=new URL(origin);matchesRequestHost=originUrl.host===request.headers.get('host')&&originUrl.protocol===new URL(request.url).protocol;}catch{throw new ApiError(403,'허용되지 않은 요청 출처예요.');}}
  // Next's internal request URL can use localhost while the public Host is 127.0.0.1.
  // A browser Origin matching its actual request Host is same-origin; cross-site stays rejected.
  if (request.headers.get('sec-fetch-site')==='cross-site' || (origin && origin!==new URL(request.url).origin && origin!==appOrigin&&!matchesRequestHost)) throw new ApiError(403,'허용되지 않은 요청 출처예요.');
}
