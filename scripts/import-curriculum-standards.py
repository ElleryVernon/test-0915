#!/usr/bin/env python3
"""Import plain-text high-school standards from the official MOE 2022 HWP archive.
Requires olefile. Does not execute embedded content. Equations/objects fail closed.
Usage: python scripts/import-curriculum-standards.py archive.zip output.json
"""
import sys,zipfile,olefile,io,zlib,struct,re,json,hashlib
from datetime import datetime, timezone
SOURCE='https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=141&boardSeq=93458&lev=0&m=0404&opType=N&s=moe&statusYN=W'
FILE='https://www.moe.go.kr/boardCnts/fileDown.do?fileSeq=1512facbda6c234a1641ac7e9c156ca2&m=&s=moe'
MAPPING='''10공수1=공통수학1;10공수2=공통수학2;10기수1=기본수학1;10기수2=기본수학2;12경수=경제 수학;12기하=기하;12대수=대수;12미적Ⅰ=미적분Ⅰ;12미적Ⅱ=미적분Ⅱ;12수과=수학과제 탐구;12수문=수학과 문화;12실통=실용 통계;12인수=인공지능 수학;12직수=직무 수학;12확통=확률과 통계;
10통사1=통합사회1;10통사2=통합사회2;10한사1=한국사1;10한사2=한국사2;12경제=경제;12국관=국제 관계의 이해;12금융=금융과 경제생활;12기지=기후변화와 지속가능한 세계;12도탐=도시의 미래 탐구;12동역=동아시아 역사 기행;12법사=법과 사회;12사문=사회와 문화;12사탐=사회문제 탐구;12세사=세계사;12세지=세계시민과 지리;12여지=여행지리;12역현=역사로 탐구하는 현대 세계;12정치=정치;12한탐=한국지리 탐구;
10공영1=공통영어1;10공영2=공통영어2;10기영1=기본영어1;10기영2=기본영어2;12미영=미디어 영어;12세영=세계 문화와 영어;12실영=실생활 영어 회화;12심독=심화 영어 독해와 작문;12심영=심화 영어;12영Ⅰ=영어Ⅰ;12영Ⅱ=영어Ⅱ;12영독=영어 독해와 작문;12영문=영미 문학 읽기;12영발=영어 발표와 토론;12직영=직무 영어;
10과탐1=과학탐구실험1;10과탐2=과학탐구실험2;10통과1=통합과학1;10통과2=통합과학2;12과사=과학의 역사와 문화;12기환=기후변화와 환경생태;12물리=물리학;12물에=물질과 에너지;12반응=화학 반응의 세계;12생과=생명과학;12세포=세포와 물질대사;12역학=역학과 에너지;12유전=생물의 유전;12융탐=융합과학 탐구;12전자=전자기와 양자;12지구=지구과학;12지시=지구시스템과학;12행우=행성우주과학;12화학=화학;
12감비=음악 감상과 비평;12연창=음악 연주와 창작;12음=음악;12음미=음악과 미디어;12스과=스포츠 과학;12스문=스포츠 문화;12스생1=스포츠 생활1;12스생2=스포츠 생활2;12운건=운동과 건강;12체육1=체육1;12체육2=체육2;12미=미술;12미감=미술 감상과 비평;12미매=미술과 매체;12미창=미술 창작;
10공국1=공통국어1;10공국2=공통국어2;12독작=독서와 작문;12독토=독서 토론과 글쓰기;12매의=매체 의사소통;12문영=문학과 영상;12문학=문학;12언탐=언어생활 탐구;12주탐=주제 탐구 독서;12직의=직무 의사소통;12화언=화법과 언어;12윤사=윤리와 사상;12윤탐=윤리문제 탐구;12인윤=인문학과 윤리;12현윤=현대사회와 윤리;
12기가=기술·가정;12데과=데이터 과학;12로봇=로봇과 공학세계;12생활=생활과학 탐구;12소생=소프트웨어와 생활;12아동=아동발달과 부모;12인기=인공지능 기초;12자립=생애 설계와 자립;12정=정보;12지재=지식 재산 일반;12창공=창의 공학 설계'''
COURSES=dict(item.strip().split('=') for item in MAPPING.split(';') if item.strip())
def paragraphs(raw):
 with olefile.OleFileIO(io.BytesIO(raw)) as ole:
  compressed=struct.unpack_from('<I',ole.openstream('FileHeader').read(),36)[0]&1
  for stream in sorted(ole.listdir()):
   if len(stream)!=2 or stream[0]!='BodyText': continue
   data=ole.openstream(stream).read()
   if compressed:data=zlib.decompress(data,-15)
   offset=0
   while offset+4<=len(data):
    head=struct.unpack_from('<I',data,offset)[0];offset+=4;tag=head&0x3ff;size=head>>20
    if size==0xfff:size=struct.unpack_from('<I',data,offset)[0];offset+=4
    record=data[offset:offset+size];offset+=size
    if tag!=67:continue
    units=list(struct.unpack('<'+'H'*(len(record)//2),record[:len(record)//2*2]));chars=[];i=0;objects=False
    while i<len(units):
     n=units[i]
     if n in [1,2,3,4,5,6,7,8,9,11,12,14,15,16,17,18,19,20,21,22,23]:
      if n==11:objects=True
      if n==9:chars.append(' ')
      i+=8
     else:
      if n>=32 or n in [10,13]:chars.append(chr(n))
      i+=1
    text=''.join(chars).encode('utf-16-le','surrogatepass').decode('utf-16-le',errors='replace').strip()
    if text:yield text,objects

def main(archive,target):
 raw=open(archive,'rb').read();records=[];seen=set();omitted=[];documents=[]
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  for entry in sorted(z.infolist(),key=lambda f:f.filename):
   if not entry.filename.lower().endswith('.hwp'):continue
   name=entry.filename
   if not entry.flag_bits&0x800:name=name.encode('cp437').decode('cp949')
   body=z.read(entry);documents.append({'name':name,'sha256':hashlib.sha256(body).hexdigest()})
   for paragraph,(text,objects) in enumerate(paragraphs(body),1):
    m=re.fullmatch(r'\[((?:10|12)[^\]]+?)\] ?(.+)',text,re.S)
    if not m:continue
    code,content=m.groups()
    # Standards precede their explanations. The source inconsistently inserts an
    # extra hyphen in explanation codes (e.g. 12동역-01-01); dedupe the identity
    # before accepting any text so explanations never replace the standard.
    identity=code.replace('-','')
    if identity in seen:continue
    seen.add(identity)
    match=re.fullmatch(r'((?:10|12).+?)-?(\d{2}-\d{2})',code)
    prefix=match.group(1) if match else ''
    reason=None
    if not match:reason='reference_not_single_standard'
    elif prefix not in COURSES:reason='unmapped_course_or_reference_typo'
    elif objects:reason='embedded_equation_or_object'
    elif '\ufffd' in content:reason='invalid_unicode'
    elif len(content)<8 or len(content)>600:reason='unexpected_text_length'
    if reason:
     omitted.append({'code':code,'reason':reason,'document':name,'paragraph':paragraph});continue
    records.append({'code':code,'course':COURSES[prefix],'text':content,'document':name,'paragraph':paragraph})
 data={'version':'2022','notice':'교육부 고시 제2022-33호','sourcePublishedAt':'2022-12-22',
       'importedAt':datetime.now(timezone.utc).isoformat(timespec='seconds'),
       'scope':'별책5–14 고등학교 성취기준 중 텍스트로 온전히 추출 가능한 기준. 교육과정 전체나 후속 정정 고시를 포함하지 않음.',
       'firstHighSchoolIntakeYear':2025,'source':SOURCE,'download':FILE,
       'archiveSha256':hashlib.sha256(raw).hexdigest(),'documents':documents,
       'excludedCodes':[item['code'] for item in omitted],'exclusions':omitted,'standards':records}
 open(target,'w').write(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
 print('CURRICULUM_IMPORTED',len(records),'standards',len(set(r['course'] for r in records)),'courses',len(omitted),'excluded')
if __name__=='__main__': main(*sys.argv[1:])
