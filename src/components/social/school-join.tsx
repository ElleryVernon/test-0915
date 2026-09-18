'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import type { ScreenProps } from '@/lib/contracts';
type School = { id: string; name: string; address: string };
export function SchoolJoin({ refresh }: Pick<ScreenProps, 'refresh'>) {
 const [query,setQuery]=useState('');
 const [rows,setRows]=useState<School[]>([]);
 const [selected,setSelected]=useState<School|null>(null);
 const [loading,setLoading]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 useEffect(()=>{
  setRows([]);setError('');
  if(query.trim().length<2){setLoading(false);return;}
  const abort=new AbortController();setLoading(true);
  const timer=setTimeout(()=>{
   api<School[]>(`/schools?q=${encodeURIComponent(query.trim())}`,undefined,'GET',{signal:abort.signal})
    .then(s=>{if(!abort.signal.aborted)setRows(s);})
    .catch(()=>{if(!abort.signal.aborted)setError('학교를 불러오지 못했어요. 검색어를 다시 입력해 주세요.');})
    .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
  },250);
  return ()=>{clearTimeout(timer);abort.abort();};
 },[query]);
 async function join(){
  if(!selected||busy)return;setBusy(true);setError('');
  try{await api('/schools/select',{id:selected.id},'POST');await refresh();}
  catch{setError('학교를 등록하지 못했어요. 다시 시도해 주세요.');}
  finally{setBusy(false);}
 }
 return <section className="page-inset py-8">
  <h2 className="text-xl font-bold">우리 학교 이야기를 만나보세요</h2>
  <p className="mt-2 text-secondary">학교를 등록하면 같은 학교의 커뮤니티를 이용할 수 있어요. 동명 학교는 주소로 확인해 주세요.</p>
  <label className="block mt-6 font-semibold" htmlFor="community-school-search">내 학교 찾기</label>
  <input id="community-school-search" className="field mt-2" placeholder="학교명 또는 지역 2자 이상" value={query} disabled={busy} onChange={e=>{setQuery(e.target.value);setSelected(null);}} />
  <div className="mt-4" aria-live="polite">
   {error&&<p role="alert">{error}</p>}
   {loading&&<p>학교를 찾고 있어요…</p>}
   {!loading&&query.trim().length>=2&&!rows.length&&!error&&<p>검색 결과가 없어요. 학교명이나 지역을 바꿔보세요.</p>}
   <div className="max-h-80 overflow-y-auto flex flex-col gap-2">
    {rows.map(s=><button key={s.id} type="button" disabled={busy} aria-pressed={selected?.id===s.id} onClick={()=>setSelected(s)} className={`text-left rounded-2xl p-4 ${selected?.id===s.id?'bg-neutral-900 text-white':'bg-neutral-100 text-neutral-900'}`}>
     <span className="block font-semibold">{s.name}{selected?.id===s.id?' · 선택됨':''}</span><span className="block text-sm mt-1">{s.address}</span>
    </button>)}
   </div>
  </div>
  <Button className="w-full mt-6" disabled={!selected||busy} onClick={join}>{busy?'학교 등록 중…':'선택한 학교 커뮤니티 시작하기'}</Button>
  <p className="text-sm text-secondary mt-3">학교 선택은 재학 인증이 아니에요. 공개 프로필에는 학교가 표시되지 않아요.</p>
 </section>;
}
