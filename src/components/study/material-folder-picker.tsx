'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Search,
  X,
} from '@/components/icons';
import { Button, IconButton, Sheet } from '@/components/ui';
import { OptionField } from '@/components/ui-choice';
import type { AppData, Material } from '@/lib/contracts';
import {
  folderForMaterial,
  folderMaterials,
  materialFolders,
  MAX_GENERATION_SOURCES,
  selectedMaterials,
  toggleMaterialSelection,
} from '@/lib/material-folders';
import { materialDate, type MaterialSort } from '@/lib/study-library';
import styles from './material-folder-picker.module.css';

type PickerProps = {
  data: Pick<AppData, 'subjects' | 'materials'>;
  selected?: Material[];
  onSelect: (ids: string[]) => void;
  confirmLabel?: string | ((count: number) => string);
  onAddMaterials?: (folder?: string) => void;
  initialFolder?: string;
};
export function MaterialFolderPicker({
  data,
  selected,
  onSelect,
  onClose,
}: PickerProps & { onClose: () => void }) {
  return (
    <Sheet open workspace onClose={onClose} title="사용할 자료 선택">
      <MaterialFolderBrowser data={data} selected={selected} onSelect={onSelect} />
    </Sheet>
  );
}

/** Selection is a draft until confirmation; navigation and searching never change it. */
export function MaterialFolderBrowser({
  data,
  selected = [],
  onSelect,
  confirmLabel,
  onAddMaterials,
  initialFolder = '',
}: PickerProps) {
  const [folder, setFolder] = useState(
    () =>
      folderForMaterial(selected.length === 1 ? selected[0] : undefined, data.subjects) ||
      initialFolder,
  );
  const [view, setView] = useState<'folders' | 'recent' | 'selected'>('folders');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<MaterialSort>('recent');
  const [chosen, setChosen] = useState(() => selected.map((item) => item.id));
  const [notice, setNotice] = useState('');
  const folders = materialFolders(data.materials, data.subjects);
  const current = folders.find((item) => item.id === folder);
  const activeFolder = current?.id || '';
  const drafts = selectedMaterials(data.materials, chosen);
  const sourcePool = view === 'selected' ? drafts : data.materials;
  const visible = folderMaterials(sourcePool, data.subjects, activeFolder, query, sort);
  const browsingFolders = view === 'folders' && !activeFolder && !query.trim();
  const hintId = useId();
  const contents = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contents.current?.scrollTo({ top: 0 });
  }, [folder, view, query, sort]);
  const openRoot = () => {
    setFolder('');
    setQuery('');
    setView('folders');
  };
  const toggle = (item: Material) => {
    if (!chosen.includes(item.id) && chosen.length >= MAX_GENERATION_SOURCES) {
      setNotice(`최대 ${MAX_GENERATION_SOURCES}개예요. 다른 자료를 먼저 해제해 주세요.`);
      return;
    }
    setChosen((ids) => toggleMaterialSelection(ids, item.id));
    setNotice('');
  };
  return (
    <div className={styles.browser} data-material-folders>
      <label className={styles.search}>
        <Search size={18} aria-hidden="true" />
        <input
          aria-label={
            current
              ? `${current.name} 폴더에서 자료 검색`
              : view === 'selected'
                ? '선택한 자료 검색'
                : '전체 자료 검색'
          }
          placeholder={
            current
              ? '이 폴더에서 자료 검색'
              : view === 'selected'
                ? '선택한 자료에서 검색'
                : '자료명 또는 과목명 검색'
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <IconButton label="검색어 지우기" onClick={() => setQuery('')}>
            <X size={16} />
          </IconButton>
        )}
      </label>
      <div className={styles.browseTop}>
        {activeFolder || view === 'selected' ? (
          <nav className={styles.breadcrumb} aria-label="자료 폴더 경로">
            <button type="button" onClick={openRoot}>
              <ArrowLeft size={17} /> 내 자료
            </button>
            <ChevronRight size={14} aria-hidden="true" />
            <strong aria-current="location">
              {view === 'selected' ? '선택한 자료' : current?.name}
            </strong>
          </nav>
        ) : (
          <div className={styles.views} role="group" aria-label="자료 탐색 방식">
            {(['folders', 'recent'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={view === item}
                onClick={() => {
                  setView(item);
                  setQuery('');
                  if (item === 'recent') setSort('recent');
                }}
              >
                {item === 'folders' ? '과목 폴더' : '최근 자료'}
              </button>
            ))}
          </div>
        )}
        {!browsingFolders && (
          <OptionField
            compact
            label="자료 정렬"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'recent', label: '최근 등록순' },
              { value: 'name', label: '이름순' },
            ]}
          />
        )}
      </div>
      <p id={hintId} className={styles.resultCount} aria-live="polite">
        {browsingFolders
          ? `폴더 ${folders.length}개 · 자료 ${data.materials.length}개`
          : `${query.trim() ? '검색 결과' : '자료'} ${visible.length}개`}
      </p>
      <div ref={contents} className={styles.contents}>
        <div key={`${view}:${activeFolder}`} className={styles.page}>
          {browsingFolders ? (
            <div className={styles.folders} aria-label="과목별 자료 폴더">
              {folders.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={styles.folder}
                  onClick={() => setFolder(item.id)}
                >
                  <FolderOpen size={26} aria-hidden="true" />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      자료 {item.count}개
                      {item.usableCount !== item.count ? ` · 선택 가능 ${item.usableCount}개` : ''}
                      {item.semester ? ` · ${item.semester}` : ''}
                    </small>
                  </span>
                  {drafts.some((m) => folderForMaterial(m, data.subjects) === item.id) && (
                    <span className={styles.folderCount}>
                      {drafts.filter((m) => folderForMaterial(m, data.subjects) === item.id).length}
                      개 선택
                    </span>
                  )}
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              ))}
              {!folders.length && (
                <div className={styles.empty}>
                  <FolderOpen size={28} />
                  <strong>아직 자료 폴더가 없어요</strong>
                  <p>내 과목·자료에서 과목을 추가하고 자료를 올려 주세요.</p>
                  {onAddMaterials && (
                    <Button variant="secondary" onClick={() => onAddMaterials(activeFolder)}>
                      자료 올리기
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div
              className={styles.files}
              role="group"
              aria-label="선택할 자료"
              aria-describedby={hintId}
            >
              {visible.map((item) => {
                const usable = item.contentLength >= 20;
                const active = chosen.includes(item.id);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={styles.file}
                    role="checkbox"
                    aria-checked={active}
                    disabled={!usable && !active}
                    onClick={() => toggle(item)}
                  >
                    <span className={styles.fileIcon}>
                      <FileText size={21} aria-hidden="true" />
                    </span>
                    <span className={styles.copy}>
                      <strong>{item.title}</strong>
                      <small>
                        {!activeFolder &&
                          `${data.subjects.find((s) => s.id === item.subjectId)?.name || '과목 미지정'} · `}
                        {item.extraction === 'combined' ? '모은 자료' : item.type.toUpperCase()} ·{' '}
                        {materialDate(item)}
                      </small>
                      {!usable && (
                        <small className={styles.unavailable}>
                          본문이 짧아요 · 20자 이상 필요해요
                        </small>
                      )}
                    </span>
                    <span className={styles.selection} aria-hidden="true">
                      {active && <Check size={15} />}
                    </span>
                  </button>
                );
              })}
              {!visible.length && (
                <div className={styles.empty}>
                  <FileText size={28} aria-hidden="true" />
                  <strong>
                    {query.trim()
                      ? '검색한 자료가 없어요'
                      : view === 'selected'
                        ? '아직 선택한 자료가 없어요'
                        : '이 폴더에 자료가 없어요'}
                  </strong>
                  <p>
                    {query.trim()
                      ? '검색어를 바꾸거나 전체 폴더에서 찾아보세요.'
                      : view === 'selected'
                        ? '같이 공부할 자료를 최대 5개 골라 주세요.'
                        : '다른 폴더를 보거나 내 과목·자료에서 자료를 올려 주세요.'}
                  </p>
                  {!query.trim() && view !== 'selected' && onAddMaterials && (
                    <Button onClick={() => onAddMaterials(activeFolder)}>
                      이 폴더에 자료 올리기
                    </Button>
                  )}
                  <Button variant="secondary" onClick={openRoot}>
                    전체 폴더 보기
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className={styles.confirm}>
        <div className={styles.selectionSummary}>
          {drafts.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setFolder('');
                setQuery('');
                setView('selected');
              }}
            >
              선택한 자료 <strong>{drafts.length}개</strong> 보기 <ChevronRight size={14} />
            </button>
          ) : (
            <p className={styles.selectionEmpty}>
              선택한 자료 <strong>0개</strong>
            </p>
          )}
          <div className={styles.selectionTools}>
            <span className={styles.selectionLimit}>최대 {MAX_GENERATION_SOURCES}개</span>
            {chosen.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setChosen([]);
                  setNotice('');
                }}
              >
                선택 해제
              </button>
            )}
          </div>
        </div>
        <p className={styles.selectionHint} role="status">
          {notice ||
            (drafts.length
              ? '선택한 자료는 다른 폴더에서도 유지돼요.'
              : '한 주제에 사용할 자료를 골라 주세요.')}
        </p>
        <Button
          className="w-full"
          disabled={
            !drafts.length ||
            drafts.length !== chosen.length ||
            drafts.some((m) => m.contentLength < 20)
          }
          onClick={() => onSelect(drafts.map((m) => m.id))}
        >
          {drafts.length
            ? typeof confirmLabel === 'function'
              ? confirmLabel(drafts.length)
              : confirmLabel || `${drafts.length}개 자료 사용하기`
            : '자료를 선택해 주세요'}{' '}
          <ChevronRight size={17} />
        </Button>
      </div>
    </div>
  );
}
