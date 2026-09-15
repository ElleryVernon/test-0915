import {oauth} from '@/lib/oauth';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{provider:string;step?:string[]}>}){const p=await params;return oauth(request,p.provider,p.step)}
export async function POST(request:Request,{params}:{params:Promise<{provider:string;step?:string[]}>}){const p=await params;return oauth(request,p.provider,p.step)}
