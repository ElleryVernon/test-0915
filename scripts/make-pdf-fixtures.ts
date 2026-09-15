// Builds the PDF fixtures in tests/fixtures/pdf with headless Chrome's own printer, so they carry real
// text layers, embedded fonts, running headers/footers and images at known places. The content is
// written for the tests; regenerate with `npx tsx scripts/make-pdf-fixtures.ts` when the fixtures change.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { launchChrome } from './lib/browser';

const out = 'tests/fixtures/pdf';
mkdirSync(out, { recursive: true });

function png(width: number, height: number, draw: (ctx: any) => void) {
  const canvas = createCanvas(width, height);
  draw(canvas.getContext('2d'));
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}
const chart = png(640, 360, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 640, 360);
  const bars = [120, 220, 180, 300];
  bars.forEach((h, i) => {
    ctx.fillStyle = ['#ff6f0f', '#212124', '#69696e', '#a5a5a8'][i];
    ctx.fillRect(60 + i * 140, 330 - h, 90, h);
  });
});
const diagram = png(560, 300, (ctx) => {
  ctx.fillStyle = '#f3f3f3';
  ctx.fillRect(0, 0, 560, 300);
  ctx.strokeStyle = '#212124';
  ctx.lineWidth = 6;
  for (let i = 0; i < 3; i++) ctx.strokeRect(30 + i * 180, 100, 140, 100);
  ctx.beginPath();
  ctx.moveTo(170, 150);
  ctx.lineTo(210, 150);
  ctx.moveTo(350, 150);
  ctx.lineTo(390, 150);
  ctx.stroke();
});
const icon = png(16, 16, (ctx) => {
  ctx.fillStyle = '#ff6f0f';
  ctx.fillRect(0, 0, 16, 16);
});
const logo = png(96, 96, (ctx) => {
  ctx.fillStyle = '#212124';
  ctx.beginPath();
  ctx.arc(48, 48, 44, 0, Math.PI * 2);
  ctx.fill();
});
// A page of text drawn into pixels: a scan has no text layer.
const scan = png(1200, 700, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1200, 700);
  ctx.fillStyle = '#111111';
  ctx.font = '44px sans-serif';
  ['광합성은 빛에너지를 화학 에너지로 바꾸는 과정이다.', '엽록체의 틸라코이드에서 명반응이 일어난다.', '스트로마에서는 캘빈 회로가 진행된다.'].forEach((line, i) =>
    ctx.fillText(line, 60, 140 + i * 120),
  );
});

const style = `
  @page { size: A4; margin: 28mm 22mm 24mm; }
  body { font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; font-size: 12pt; line-height: 1.7; color: #111; }
  h1 { font-size: 24pt; margin: 40mm 0 8mm; }
  h2 { font-size: 16pt; margin: 0 0 4mm; }
  p { margin: 0 0 4mm; text-align: justify; }
  .toc div { margin: 1mm 0; }
  .page { break-before: page; }
  ul { list-style: none; padding: 0; margin: 0 0 4mm; }
  img.figure { display: block; width: 120mm; margin: 4mm 0; }
  img.icon { width: 5mm; height: 5mm; }
`;
const header = `<div style="font-size:9px;width:100%;padding:0 22mm;display:flex;align-items:center;gap:6px;color:#555"><img src="${logo}" style="width:6mm;height:6mm">기후테크 창업가 육성사업 · 검증 자료</div>`;
const footer = `<div style="font-size:9px;width:100%;text-align:center;color:#555">- <span class="pageNumber"></span> -</div>`;
const documentHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${style}</style></head><body>
<h1>기후테크 창업가 육성사업 제안 요청서</h1>
<p>2023. 11.</p>
<div class="toc"><h2>목 차</h2>
<div>I. 공모 개요 ................................................ 2</div>
<div>II. 선정 절차 ................................................ 3</div>
</div>
<section class="page">
<h2>I. 공모 개요</h2>
<p>이 사업은 기후 문제를 기술로 푸는 초기 창업가를 찾아 교육과 투자, 실증 기회를 함께 제공하는 프로그램이다. 선정된 팀은 여섯 달 동안 전문가 멘토링을 받고, 협력 기관의 현장에서 시제품을 시험하며, 마지막 발표회에서 후속 투자를 논의할 수 있다. 지원 규모는 아래 그림과 같다.</p>
<img class="figure" src="${chart}" alt="">
<p>그림 아래 문단은 선정 이후의 일정을 설명한다. 모든 일정은 사정에 따라 바뀔 수 있다.</p>
<ul>
<li>○ 모집 대상: 창업 3년 이내의 기후테크 기업</li>
<li>○ 지원 내용: 사업화 자금과 실증 공간 <img class="icon" src="${icon}" alt=""></li>
</ul>
</section>
<section class="page">
<h2>II. 선정 절차</h2>
<p>서류와 발표로 두 번 평가한다. 평가 기준은 기술의 탄소 감축 효과, 사업 모델의 현실성, 팀의 실행 역량이다.</p>
<img class="figure" src="${diagram}" alt="">
<p>1. 서류 심사</p>
<p>2. 발표 평가</p>
</section>
</body></html>`;
const scannedHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${style} img.scan{display:block;width:166mm;margin-top:10mm}</style></head><body>
<img class="scan" src="${scan}" alt="">
<section class="page"><h2>둘째 쪽</h2><p>이 쪽에는 글자 층이 있다. 첫 쪽은 스캔한 그림이라 글자를 읽으려면 OCR이 필요하다.</p></section>
</body></html>`;

const { cdp, close } = await launchChrome();
try {
  for (const [name, html, withFurniture] of [
    ['document', documentHtml, true],
    ['scanned', scannedHtml, false],
  ] as const) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    const { frameTree } = await send('Page.getFrameTree');
    await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await new Promise((r) => setTimeout(r, 800));
    const { data } = await send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: withFurniture,
      headerTemplate: withFurniture ? header : '<span></span>',
      footerTemplate: withFurniture ? footer : '<span></span>',
    });
    writeFileSync(join(out, `${name}.pdf`), Buffer.from(data, 'base64'));
    console.log(`${name}.pdf ${Buffer.from(data, 'base64').length} bytes`);
    await cdp.send('Target.closeTarget', { targetId });
  }
} finally {
  await close();
}
