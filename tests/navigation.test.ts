import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JourneyHistory,
  internalPath,
  mainTab,
  readJourney,
  type JourneyEntry,
} from '../src/lib/navigation';

function fixture(path = '/', state: Record<string, unknown> = { framework: 'preserved' }) {
  const entries = [{ path, state }];
  let position = 0;
  let scroll = 0;
  const motions: number[] = [];
  const renders: { entry: JourneyEntry; keep: boolean; restore: boolean }[] = [];
  const clone = (value: Record<string, unknown>) => structuredClone(value);
  const host = {
    path: () => entries[position].path,
    state: () => entries[position].state,
    replace: (state: Record<string, unknown>, path: string) => {
      entries[position] = { state: clone(state), path };
    },
    push: (state: Record<string, unknown>, path: string) => {
      entries.splice(position + 1);
      entries.push({ state: clone(state), path });
      position++;
    },
    go: (delta: number) => {
      motions.push(delta);
    },
    scroll: () => scroll,
    render: (entry: JourneyEntry, keep: boolean, restore: boolean) => {
      renders.push({ entry: structuredClone(entry), keep, restore });
    },
  };
  let history = new JourneyHistory(host);
  const travel = (delta: number) => {
    assert.ok(
      position + delta >= 0 && position + delta < entries.length,
      'must not leave app history',
    );
    position += delta;
    history.pop();
  };
  return {
    get history() {
      return history;
    },
    entries,
    renders,
    motions,
    travel,
    restart: () => {
      history = new JourneyHistory(host);
    },
    flush: () => {
      while (motions.length) travel(motions.shift()!);
    },
    scroll: (n: number) => {
      scroll = n;
    },
    current: () => entries[position],
    position: () => position,
  };
}

test('Back reverses real entry without pushing the fallback and Forward restores its destination', () => {
  const f = fixture();
  f.history.navigate('/study');
  f.scroll(430);
  f.history.remember('semester', '2026-1');
  f.history.navigate('/search');
  f.history.remember('q', '세포');
  f.history.navigate('/subjects/bio?material=cell');
  f.history.back('/study');
  f.flush();
  assert.equal(f.current().path, '/search');
  assert.equal(f.history.entry.view.q, '세포');
  f.history.back('/');
  f.flush();
  assert.equal(f.current().path, '/study');
  assert.equal(f.history.entry.scroll, 430);
  assert.equal(f.history.entry.view.semester, '2026-1');
  assert.equal(f.renders.at(-1)?.restore, true);
  f.travel(1);
  assert.equal(f.current().path, '/search');
  assert.equal(f.entries.length, 4);
  assert.equal(f.current().state.framework, 'preserved');
});

test('repeated active tab taps do not create duplicate history', () => {
  const f = fixture('/study');
  const id = f.history.entry.id;
  for (let i = 0; i < 5; i++) f.history.navigate('/study');
  assert.equal(f.entries.length, 1);
  assert.equal(f.history.entry.id, id);
  assert.equal(f.renders.length, 0);
});

test('direct link Back replaces safely instead of going to an unrelated browser page', () => {
  const f = fixture('/settings/learning');
  f.history.back('/profile');
  assert.equal(f.current().path, '/profile');
  assert.equal(f.entries.length, 1);
  assert.deepEqual(f.motions, []);
});

test('browser Back closes only the top layer without changing route, view state or scroll', () => {
  const f = fixture('/planner');
  const closed: string[] = [];
  f.history.remember('date', '2026-09-17');
  f.scroll(510);
  f.history.openLayer(() => closed.push('editor'));
  f.history.openLayer(() => closed.push('date-picker'));
  f.travel(-1);
  assert.deepEqual(closed, ['date-picker']);
  assert.equal(f.renders.length, 0);
  f.travel(-1);
  assert.deepEqual(closed, ['date-picker', 'editor']);
  assert.equal(f.current().path, '/planner');
  assert.equal(f.history.entry.view.date, '2026-09-17');
  assert.equal(f.history.entry.scroll, 510);
});

test('header close consumes its layer entry and next Back reaches the previous route', () => {
  const f = fixture('/study');
  f.history.navigate('/planner');
  let closed = 0;
  const layer = f.history.openLayer(() => closed++);
  f.history.closeLayer(layer);
  f.flush();
  assert.equal(closed, 1);
  f.history.back('/');
  f.flush();
  assert.equal(f.current().path, '/study');
});

test('navigation from nested sheets waits for history and pushes only the intended destination', () => {
  const f = fixture('/study');
  f.history.navigate('/subjects/bio');
  f.history.openLayer(() => {});
  f.history.openLayer(() => {});
  f.history.navigate('/quiz?material=cell');
  assert.equal(f.current().path, '/subjects/bio');
  f.flush();
  assert.equal(f.current().path, '/quiz?material=cell');
  assert.equal(f.entries.length, 3);
  f.history.back();
  f.flush();
  assert.equal(f.current().path, '/subjects/bio');
});

test('replacing a sheet with a child sheet must not notify the old controlled onClose', () => {
  const f = fixture('/subjects/bio');
  let parentClosed = false;
  let childClosed = false;
  const parent = f.history.openLayer(() => {
    parentClosed = true;
  });
  f.history.closeLayer(parent, false);
  f.history.openLayer(() => {
    childClosed = true;
  });
  f.flush();
  assert.equal(parentClosed, false);
  assert.equal(f.entries.length, 2);
  f.travel(-1);
  assert.equal(childClosed, true);
  assert.equal(parentClosed, false);
});

test('one-shot intent replacement keeps the active sheet and view, then closes normally', () => {
  const f = fixture('/flashcards?generate=1');
  let closed = false;
  const layer = f.history.openLayer(() => {
    closed = true;
  });
  f.history.remember('subject', 'bio');
  const id = f.history.entry.id;
  f.history.navigate('/flashcards', { replace: true, keepScreen: true });
  assert.equal(closed, false);
  assert.equal(f.history.entry.id, id);
  assert.equal(f.history.entry.view.subject, 'bio');
  f.history.closeLayer(layer);
  f.flush();
  assert.equal(closed, true);
  assert.equal(f.current().path, '/flashcards');
});

test('reloaded app entry retains its local Back ancestry and input state', () => {
  const f = fixture('/study');
  f.history.navigate('/search');
  f.history.remember('q', '세포');
  const next = fixture(f.current().path, f.current().state);
  assert.equal(next.history.entry.depth, 1);
  assert.equal(next.history.entry.view.q, '세포');
});

test('external and malformed destinations never mutate history; valid paths are a positive control', () => {
  const f = fixture();
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/\n/evil.test']) {
    assert.equal(internalPath(path), false);
    f.history.navigate(path);
  }
  assert.equal(f.entries.length, 1);
  f.history.navigate('/study?subject=bio');
  assert.equal(f.entries.length, 2);
  assert.equal(readJourney({ __memoryzJourney: { id: 'x', depth: -1 } }), null);
});

test('main-menu return restores that tab context while creating a distinct visit', () => {
  const f = fixture('/planner');
  const original = f.history.entry.id;
  f.history.remember('date', '2026-09-17');
  f.scroll(180);
  f.history.navigate('/study', { restore: true });
  f.history.navigate('/planner', { restore: true });
  assert.equal(f.history.entry.view.date, '2026-09-17');
  assert.equal(f.history.entry.scroll, 180);
  assert.notEqual(f.history.entry.id, original);
  assert.equal(f.renders.at(-1)?.restore, true);
});

test('secondary account screens and aliases indicate their owning main menu', () => {
  assert.equal(mainTab('/settings/learning'), '/profile');
  assert.equal(mainTab('/notifications'), '/profile');
  assert.equal(mainTab('/subjects/bio?material=cell'), '/study');
  assert.equal(mainTab('/boards'), '/community');
  assert.equal(mainTab('/', true), '/parent');
  assert.equal(mainTab('/parent-boards?post=a', true), '/parent-boards');
});

test('a layer unmounted while another closes cannot register a ghost layer later', () => {
  const f = fixture('/planner');
  const first = f.history.openLayer(() => {});
  f.history.closeLayer(first, false);
  const cancelled = f.history.openLayer(() => assert.fail('unmounted layer callback'));
  f.history.closeLayer(cancelled, false);
  f.flush();
  assert.equal(f.position(), 0);
  assert.equal(readJourney(f.current().state)?.layer, undefined);
});

test('reload with nested sheets consumes obsolete layer markers before new layers mount', () => {
  const f = fixture('/study');
  f.history.navigate('/subjects/bio?material=cell');
  f.history.openLayer(() => {});
  f.history.openLayer(() => {});
  f.restart();
  const fresh = f.history.openLayer(() => {});
  f.flush();
  assert.equal(f.position(), 2);
  assert.equal(f.entries.length, 3);
  f.history.closeLayer(fresh);
  f.flush();
  f.history.back('/study');
  f.flush();
  assert.equal(f.current().path, '/study');
});

test('a child route does not discard the source exercise through layer dismissal', () => {
  const f = fixture('/study');
  f.history.navigate('/quiz');
  f.history.remember('session', ['q1', 'q2']);
  f.history.openLayer(() => f.history.remember('session', null));
  f.history.navigate('/completed-subjects');
  f.flush();
  f.history.back();
  f.flush();
  assert.deepEqual(f.history.entry.view.session, ['q1', 'q2']);
});

test('screen exit consumes local exercise stages while browser Back handles one stage at a time', () => {
  const f = fixture('/essay');
  f.history.navigate('/essay?essay=one');
  const closed: number[] = [];
  f.history.openLayer(() => closed.push(2));
  f.history.openLayer(() => closed.push(3));
  f.history.openLayer(() => closed.push(4));
  f.travel(-1);
  assert.deepEqual(closed, [4]);
  f.history.back('/essay');
  f.flush();
  assert.equal(f.current().path, '/essay');
  assert.deepEqual(
    closed,
    [4],
    'screen exit must preserve the draft instead of resetting each stage',
  );
});

test('completed exercise exits through stage callbacks and the following Back renders its parent', () => {
  const f = fixture('/study');
  f.history.navigate('/essay');
  f.history.navigate('/essay?essay=one');
  for (let i = 0; i < 3; i++) f.history.openLayer(() => {});
  f.restart();
  for (let i = 0; i < 3; i++) f.history.openLayer(() => f.history.back('/essay'));
  f.flush();
  f.travel(-1);
  f.flush();
  assert.equal(f.history.entry.path, '/essay');
  assert.equal(f.renders.at(-1)?.entry.path, '/essay');
  f.history.back('/study');
  f.flush();
  assert.equal(f.history.entry.path, '/study');
  assert.equal(f.renders.at(-1)?.entry.path, '/study');
});

test('completing an exercise retires all stage layers before the result route is left', () => {
  const f = fixture('/study');
  f.history.navigate('/essay');
  f.history.navigate('/essay?essay=one');
  const layers = [2, 3, 4].map(() => f.history.openLayer(() => {}));
  for (const layer of layers) f.history.closeLayer(layer, false);
  f.flush();
  assert.equal(f.current().path, '/essay?essay=one');
  f.travel(-1);
  assert.equal(f.renders.at(-1)?.entry.path, '/essay');
  f.history.back();
  f.flush();
  assert.equal(f.renders.at(-1)?.entry.path, '/study');
});

test('search state survives a material reload and its regenerated sheet closing', () => {
  const f = fixture('/study');
  f.history.navigate('/search');
  f.history.remember('student:search.query', '세포');
  f.history.navigate('/subjects/bio?material=cell');
  f.history.openLayer(() => {});
  f.restart();
  const sheet = f.history.openLayer(() => {});
  f.flush();
  f.history.closeLayer(sheet);
  f.flush();
  f.history.back();
  f.flush();
  assert.equal(f.history.entry.path, '/search');
  assert.equal(f.history.entry.view['student:search.query'], '세포');
});

test('a late response updates its original screen, never the current screen', () => {
  const f = fixture('/quiz');
  const quizEntry = f.history.entry.id;
  f.history.remember('result', null);
  f.history.navigate('/study');
  f.history.remember('result', { correct: false }, quizEntry);
  assert.equal(f.history.entry.view.result, undefined);
  f.history.back();
  f.flush();
  assert.deepEqual(f.history.entry.view.result, { correct: false });
});

test('community inbox and community profile retain community main-menu ownership', () => {
  assert.equal(mainTab('/messages'), '/community');
  assert.equal(mainTab('/community?space=messages&peer=abc'), '/community');
  assert.equal(mainTab('/community/me'), '/community');
  assert.equal(mainTab('/parent-boards/me', true), '/parent-boards');
});
