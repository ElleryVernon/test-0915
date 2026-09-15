import { randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,unlink } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db';
import { ApiError } from './errors';
import type { User } from './generated/client';
import { aiAvailable } from './provider';
import { extractImageText } from './ai';

const directory=path.join(process.cwd(),'.data','uploads');
export async function handleUpload(request:Request,user:User) {
  if(Number(request.headers.get('content-length')??0)>11_000_000)throw new ApiError(413,'파일은 10MB 이하로 올려 주세요.');
  const form=await request.formData();
  const file=form.get('file');
  if(!(file instanceof File))throw new ApiError(400,'파일을 선택해 주세요.');
  if(!file.size||file.size>10_000_000)throw new ApiError(413,'빈 파일이거나 10MB를 초과했어요.');
  const buffer=Buffer.from(await file.arrayBuffer());
  const extension=file.name.split('.').pop()?.toLowerCase();
  let type:string;let mime:string;let content='';
  if(extension==='txt') {
    if(buffer.includes(0))throw new ApiError(400,'UTF-8 텍스트 파일을 올려 주세요.');
    type='TXT';mime='text/plain; charset=utf-8';content=buffer.toString('utf8').replace(/^\uFEFF/,'');
  } else if(extension==='pdf'&&buffer.subarray(0,5).toString()==='%PDF-') {
    type='PDF';mime='application/pdf';
    const {PDFParse}=await import('pdf-parse');
    const parser=new PDFParse({data:new Uint8Array(buffer)});
    try {content=(await parser.getText()).text;}catch {throw new ApiError(422,'PDF를 읽지 못했어요. 암호를 해제하거나 텍스트 자료를 올려 주세요.');}finally{await parser.destroy();}
  } else if(['png','jpg','jpeg','webp'].includes(extension??'')) {
    const png=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
    const webp=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';
    if(!png&&!jpeg&&!webp)throw new ApiError(400,'이미지 파일 내용을 확인해 주세요.');
    type='IMAGE';mime=png?'image/png':jpeg?'image/jpeg':'image/webp';
    if(aiAvailable())content=await extractImageText(buffer,mime);
  } else throw new ApiError(415,'TXT, PDF, PNG, JPG, WebP 파일을 올려 주세요.');
  if(content.length>200_000)throw new ApiError(413,'본문이 너무 길어요. 자료를 나누어 올려 주세요.');
  const uploadId=randomUUID();
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(path.join(directory,uploadId),buffer,{mode:0o600,flag:'wx'});
  try { await db.upload.create({data:{id:uploadId,userId:user.id,mime,name:file.name.slice(0,200),size:buffer.length}}); }
  catch(error){await unlink(path.join(directory,uploadId));throw error;}
  return {url:`/api/uploads/${uploadId}`,content,type,title:file.name.replace(/\.[^.]+$/,'').slice(0,200),...(!content?{warning:'추출된 본문이 없어요. 학습 내용을 직접 입력해 주세요.'}:{})};
}
export async function readUpload(uploadId:string,user:User) {
  if(!/^[a-f0-9-]{36}$/.test(uploadId))throw new ApiError(404,'파일을 찾을 수 없어요.');
  const upload=await db.upload.findFirst({where:{id:uploadId,userId:user.id}});
  if(!upload)throw new ApiError(404,'파일을 찾을 수 없어요.');
  let file:Buffer;
  try {file=await readFile(path.join(directory,uploadId));}catch{throw new ApiError(404,'파일을 찾을 수 없어요.');}
  return new Response(new Uint8Array(file),{headers:{'Content-Type':upload.mime,'Content-Length':String(upload.size),'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(upload.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
