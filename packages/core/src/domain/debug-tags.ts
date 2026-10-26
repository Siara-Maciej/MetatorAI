/**
 * Instrumentation markers (`mt-diagnose`, W8): every temporary log line carries a tag, `[DEBUG-`
 * followed by four or more hex digits and `]`, so `debug-tags check` can prove the cleanup removed
 * all of them.
 */
const DEBUG_TAG = /\[DEBUG-[0-9a-f]{4,}\]/gi;

export interface DebugTag {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
}

export function findDebugTags(file: string, content: string): DebugTag[] {
  const out: DebugTag[] = [];
  content.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(DEBUG_TAG)) out.push({ file, line: i + 1, tag: m[0] });
  });
  return out;
}
