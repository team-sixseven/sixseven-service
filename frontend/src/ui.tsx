import { createContext, useContext } from 'react';
import type { User } from './types';

export type ModalState =
  | { type: 'search' }
  | { type: 'settings' }
  | { type: 'model' }
  | { type: 'demo' }
  | { type: 'admin'; tab: 'model' | 'logs' }
  | { type: 'action'; mode: 'act' | 'change' | 'memo'; alertId: string; patientId: string };

export interface Ui {
  user: User;
  selectedId: string | null;
  select: (id: string | null) => void;
  snack: (message: string) => void;
  modal: ModalState | null;
  origin: { x: number; y: number } | null;
  openModal: (modal: ModalState, from?: HTMLElement | null) => void;
  closeModal: () => void;
  logout: () => void;
  sort: string; // SortKey
  query: string;
  setQuery: (q: string) => void;
  syncing: boolean;
  sync: () => void;
}

export const UiContext = createContext<Ui | null>(null);
export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('UiContext가 없습니다.');
  return ui;
}
