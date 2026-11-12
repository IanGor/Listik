import { createContext } from 'solid-js';
import type { Outliner } from './outliner';

export interface SplitControls {
  enabled: () => boolean;
  wide: () => boolean;
  toggle: () => void;
  active: (o: Outliner) => boolean;
}
export const SplitContext = createContext<SplitControls>();
