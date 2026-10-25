import GithubSlugger from "github-slugger";

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Anchors GitHub generates for a Markdown document's headings (github-slugger: lower case,
 * punctuation dropped, duplicates suffixed `-1`, `-2`). Headings inside code fences are skipped.
 */
export function markdownAnchors(markdown: string): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (f && (!fence || f.startsWith(fence))) {
      fence = fence ? undefined : f;
      continue;
    }
    if (fence) continue;
    const text = HEADING.exec(line)?.[2];
    if (text) anchors.add(slugger.slug(text.replace(/`/g, "")));
  }
  return anchors;
}
