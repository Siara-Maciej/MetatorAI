import { useInsertionEffect, useRef } from "react";

/**
 * A ref that always holds the latest value, written after the render (never during it, which
 * React Compiler refuses): read it in an effect or an event, never while rendering.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}
