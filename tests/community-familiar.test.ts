import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { blockPreviewText, BlockView } from '../src/components/social/community-blocks';
import type { CommunityBlock } from '../src/lib/community-types';
import type { AppData } from '../src/lib/contracts';
const question: CommunityBlock = {id:'block-question', type:'QUESTION', hidden:true, payload:{prompt:'식사 후 분비되는 호르몬은?',options:['인슐린','글루카곤'],answer:0,explanation:'정답 해설은 가려져야 해요.'}};
const data = {profile:{id:'viewer',role:'STUDENT'},materials:[],subjects:[],schedules:[]} as unknown as AppData;
test('draft preview summarizes the attached prompt without leaking its answer or explanation',()=>{
 assert.equal(blockPreviewText(question),'식사 후 분비되는 호르몬은?');
 assert.equal(blockPreviewText({...question,type:'CARD',payload:{front:'앞면 질문',back:'가려진 뒷면'}}),'앞면 질문');
});
test('a private message question exposes the same solve affordance as a community question',()=>{
 const markup=renderToStaticMarkup(createElement(BlockView,{block:question,messageId:'message-private',data,navigate:()=>{},toast:()=>{}}));
 assert.match(markup,/나도 풀어보기/);
 assert.match(markup,/정답 보기/);
 assert.doesNotMatch(markup,/정답 해설은 가려져야/);
 const draft=renderToStaticMarkup(createElement(BlockView,{block:question,preview:true,data,navigate:()=>{},toast:()=>{}}));
 assert.doesNotMatch(draft,/나도 풀어보기/);
});
