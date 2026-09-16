'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
  type Dispatch,
} from 'react';
import { JourneyHistory } from '@/lib/navigation';
export const JourneyUserContext = createContext('');
export const JourneyContext = createContext<JourneyHistory | null>(null);

/** Small view state belongs to the history entry, so returning restores the exact list context. */
export function useJourneyState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const journey = useContext(JourneyContext);
  const user = useContext(JourneyUserContext);
  key = `${user}:${key}`;
  const [entryId] = useState(() => journey?.entry.id);
  const [value, setValue] = useState<T>(() => {
    const saved = journey?.entry.view[key];
    return saved !== undefined ? (saved as T) : initial instanceof Function ? initial() : initial;
  });
  const ref = useRef(value);
  const set: Dispatch<SetStateAction<T>> = useCallback(
    (next) => {
      const result = next instanceof Function ? next(ref.current) : next;
      ref.current = result;
      journey?.remember(key, result, entryId);
      setValue(result);
    },
    [journey, key, entryId],
  );
  return [value, set];
}

/** One history entry per visible layer, shared by all sheets and local exercise steps. */
export function useJourneyLayer(open: boolean, onClose: () => void) {
  const journey = useContext(JourneyContext);
  const callback = useRef(onClose);
  callback.current = onClose;
  const layer = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !journey) return;
    const entry = journey.entry.id;
    const token = journey.openLayer(() => {
      layer.current = null;
      callback.current();
    });
    layer.current = token;
    return () => {
      if (layer.current === token) {
        layer.current = null;
        if (journey.entry.id === entry) journey.closeLayer(token, false);
      }
    };
  }, [open, journey]);
  return () => {
    if (journey && layer.current) journey.closeLayer(layer.current);
    else callback.current();
  };
}
