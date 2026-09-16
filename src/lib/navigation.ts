/** The client shell owns its history. Keep framework state alongside our namespaced entry. */
export interface JourneyEntry {
  id: string;
  depth: number;
  path: string;
  scroll: number;
  view: Record<string, unknown>;
  layer?: string;
  layerDepth?: number;
}
export interface JourneyHost {
  path(): string;
  state(): Record<string, unknown> | null;
  replace(state: Record<string, unknown>, path: string): void;
  push(state: Record<string, unknown>, path: string): void;
  go(delta: number): void;
  scroll(): number;
  render(entry: JourneyEntry, keepScreen: boolean, restore: boolean): void;
}
export type NavigationOptions = { replace?: boolean; keepScreen?: boolean; restore?: boolean };
const KEY = '__memoryzJourney';
let serial = 0;
function id() {
  return `${Date.now().toString(36)}-${++serial}`;
}
export function internalPath(path: string) {
  return path.startsWith('/') && !path.startsWith('//') && !/[\\\r\n]/.test(path);
}
export function readJourney(state: Record<string, unknown> | null): JourneyEntry | null {
  const value = state?.[KEY] as JourneyEntry | undefined;
  return value &&
    typeof value.id === 'string' &&
    Number.isInteger(value.depth) &&
    value.depth >= 0 &&
    typeof value.path === 'string' &&
    internalPath(value.path) &&
    typeof value.scroll === 'number' &&
    value.view &&
    typeof value.view === 'object'
    ? value
    : null;
}
export class JourneyHistory {
  entry: JourneyEntry;
  private layers: { id: string; close: () => void }[] = [];
  private pending: (() => void) | null = null;
  private moving = false;
  private snapshots = new Map<string, JourneyEntry>();
  private tabSnapshots = new Map<string, JourneyEntry>();
  private cancelledLayers = new Set<string>();
  constructor(private host: JourneyHost) {
    const saved = readJourney(host.state());
    this.entry =
      saved?.path === host.path()
        ? { ...saved, layer: undefined }
        : {
            id: id(),
            depth: 0,
            path: host.path(),
            scroll: 0,
            view: {},
          };
    this.write(false);
    // A reload discards transient UI. Consume its old layer markers before a new sheet registers.
    if (
      saved?.layer &&
      saved.path === host.path() &&
      Number.isInteger(saved.layerDepth) &&
      saved.layerDepth! > 0
    ) {
      this.moving = true;
      host.go(-saved.layerDepth!);
    }
  }
  private write(push: boolean, layer?: string) {
    const state = {
      ...this.host.state(),
      [KEY]: { ...this.entry, layer, layerDepth: this.layers.length },
    };
    if (push) this.host.push(state, this.entry.path);
    else this.host.replace(state, this.entry.path);
  }
  private save() {
    this.entry.scroll = this.host.scroll();
    this.snapshots.set(this.entry.id, { ...this.entry, view: { ...this.entry.view } });
    this.tabSnapshots.set(this.entry.path, { ...this.entry, view: { ...this.entry.view } });
    this.write(false, this.layers.at(-1)?.id);
  }
  remember(key: string, value: unknown, entryId = this.entry.id) {
    if (entryId !== this.entry.id) {
      const prior = this.snapshots.get(entryId);
      if (prior) this.snapshots.set(entryId, { ...prior, view: { ...prior.view, [key]: value } });
      return;
    }
    this.entry.view = { ...this.entry.view, [key]: value };
    this.write(false, this.layers.at(-1)?.id);
  }
  private afterLayers(action: () => void) {
    if (this.moving) {
      this.pending = action;
      return;
    }
    if (!this.layers.length) {
      action();
      return;
    }
    const count = this.layers.length;
    this.layers.splice(0);
    this.pending = action;
    this.moving = true;
    // Leaving a route unmounts its layers; do not run dismissal callbacks that erase resumable work.
    this.host.go(-count);
  }
  navigate(path: string, options?: NavigationOptions) {
    if (!internalPath(path)) return;
    if (options?.replace && options.keepScreen) {
      this.entry.path = path;
      this.write(false, this.layers.at(-1)?.id);
      this.host.render(this.entry, true, false);
      return;
    }
    this.afterLayers(() => {
      if (path === this.entry.path) return;
      this.save();
      const keep = !!options?.keepScreen;
      const restored = options?.restore ? this.tabSnapshots.get(path) : undefined;
      this.entry = {
        id: keep ? this.entry.id : id(),
        depth: this.entry.depth + (options?.replace ? 0 : 1),
        path,
        scroll: keep ? this.entry.scroll : (restored?.scroll ?? 0),
        view: keep ? this.entry.view : { ...restored?.view },
      };
      this.write(!options?.replace);
      this.host.render(this.entry, keep, !!restored);
    });
  }
  back(fallback = '/study') {
    if (this.moving) return;
    if (this.layers.length) {
      this.afterLayers(() => this.back(fallback));
      return;
    }
    if (this.entry.depth > 0) {
      this.save();
      this.host.go(-1);
    } else this.navigate(fallback, { replace: true });
  }
  openLayer(close: () => void) {
    const layer = { id: id(), close };
    const attach = () => {
      if (this.cancelledLayers.delete(layer.id)) return;
      this.save();
      this.layers.push(layer);
      this.write(true, layer.id);
    };
    if (this.moving) {
      const prior = this.pending;
      this.pending = () => {
        prior?.();
        attach();
      };
    } else attach();
    return layer.id;
  }
  closeLayer(layerId: string, notify = true) {
    const index = this.layers.findIndex((l) => l.id === layerId);
    if (index < 0) {
      if (this.moving) this.cancelledLayers.add(layerId);
      return;
    }
    if (this.moving) return;
    const removed = this.layers.splice(index);
    this.moving = true;
    for (const layer of removed.reverse()) if (notify || layer.id !== layerId) layer.close();
    this.host.go(-removed.length);
  }
  pop() {
    const incoming = readJourney(this.host.state());
    if (this.moving) {
      this.moving = false;
      const pending = this.pending;
      this.pending = null;
      // The base entry is current again. Never remount the screen for a sheet dismissal.
      this.write(false, this.layers.at(-1)?.id);
      pending?.();
      return;
    }
    if (incoming?.id === this.entry.id && this.layers.length) {
      const target = incoming.layer ? this.layers.findIndex((l) => l.id === incoming.layer) + 1 : 0;
      const removed = this.layers.splice(target);
      for (const layer of removed.reverse()) layer.close();
      this.write(false, this.layers.at(-1)?.id);
      return;
    }
    // Layer markers left in forward history are inert after dismissal, never reopen a stale form.
    if (incoming?.id === this.entry.id && incoming.layer) {
      this.write(false);
      return;
    }
    this.snapshots.set(this.entry.id, { ...this.entry, scroll: this.host.scroll() });
    for (const layer of this.layers.splice(0).reverse()) layer.close();
    const saved = incoming && this.snapshots.get(incoming.id);
    this.entry = incoming
      ? { ...(saved ?? incoming), path: this.host.path(), layer: undefined }
      : {
          id: id(),
          depth: 0,
          path: this.host.path(),
          scroll: 0,
          view: {},
        };
    this.write(false);
    this.host.render(this.entry, false, true);
  }
}

/** Main menu ownership stays visible in secondary account and study routes. */
export function mainTab(path: string, parent = false): string {
  const base = path.split('?')[0];
  if (
    /^\/(study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects|search)(\/|$)/.test(
      base,
    )
  )
    return '/study';
  if (/^\/(profile|settings|notifications|admin|followers|following)(\/|$)/.test(base))
    return '/profile';
  if (/^\/(community|boards|parent-boards|messages)(\/|$)/.test(base))
    return parent ? '/parent-boards' : '/community';
  return base === '/' && parent ? '/parent' : base;
}
