import { createContext, useContext } from 'react';

/**
 * True inside a turn's work section. Steps there (tool cards, thinking) start collapsed, so opening
 * the section shows one line per step instead of every step's details at once.
 */
export const StepsStartCollapsedContext = createContext(false);

export function useStepsStartCollapsed(): boolean {
  return useContext(StepsStartCollapsedContext);
}
