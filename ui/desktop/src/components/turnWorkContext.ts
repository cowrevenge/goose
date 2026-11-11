import { createContext, useContext } from 'react';

/**
 * True inside a turn's work section. Steps there (tool cards, thinking) start collapsed, so opening
 * the section shows one line per step instead of every step's details at once.
 */
export const StepsStartCollapsedContext = createContext(false);

export function useStepsStartCollapsed(): boolean {
  return useContext(StepsStartCollapsedContext);
}

/**
 * Whether the enclosing work section is open (true outside one). A step that starts open draws
 * nothing while its section is folded, so thinking that streams in is not rendered out of sight.
 */
export const TurnWorkOpenContext = createContext(true);

export function useTurnWorkOpen(): boolean {
  return useContext(TurnWorkOpenContext);
}
