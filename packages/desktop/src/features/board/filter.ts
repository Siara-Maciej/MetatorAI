/**
 * The Board's filter, kept in the window's storage (`metator.board`) under try/catch.
 */
import { type BoardFilter, filterFromStorage, NO_FILTER } from "../../shared/model/board.ts";

const STORE = "metator.board";
export function readFilter(): BoardFilter {
  try {
    return filterFromStorage(window.localStorage.getItem(STORE));
  } catch {
    return NO_FILTER;
  }
}
export function saveFilter(f: BoardFilter): void {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(f));
  } catch {
    // A window without storage keeps the filter until it closes.
  }
}
