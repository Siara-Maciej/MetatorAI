/**
 * A question an agent asks the person in its own words, at the end of its turn (ADR-0091): its
 * last message, read from the rendered screen, ends with a question mark, offers numbered,
 * lettered or bulleted choices with a cue to reply, or says it waits for the person. Detection
 * is conservative: a report, a wait for a worker or a summary is no question. A safety net:
 * agents are told to ask with `metator run ask` (a card).
 */
export interface AgentQuestionRead {
  /** The question in one line: the first sentence, and "Which option?" when it offers some. */
  readonly prompt: string;
  /** The whole message, its lines as shown (indent taken off), for the card to show expanded. */
  readonly text: string;
  /** Its choices: the label (first line) and what is typed for it (the number, or the reply word). */
  readonly options: readonly { readonly label: string; readonly reply: string }[];
}

/** The longest one-line prompt. */
const PROMPT_MAX = 200;
/** An empty input line: Claude Code's `❯`, a generic `>`. */
const INPUT = /^\s*[❯>]\s*$/;
/** A rule drawn around the input box. */
const RULE = /^\s*─{3,}/;
/** Lines that are no part of a message: a spinner's status, a tool's output, a command echoed. */
const NOT_MESSAGE = /^\s*([✻✢✳✶✽·]\s|⎿|\$\s)/;
/** The start of an assistant's message in Claude Code. */
const MESSAGE = /^\s*●\s/;
const NUMBERED = /^(\d{1,2})[.)]\s+(.+)$/;
const LETTERED = /^([a-h])[.)]\s+(.+)$/;
const BULLETED = /^[-•*]\s+(.+)$/;
/** What tells the person to reply to choices. */
const CUE =
  /options?:|\breply\b|\bchoose\b|\bpick\b|\bwhich\b|\btell me\b|\blet me know\b|waiting for your (reply|answer|decision)/i;
/** What says the agent waits for the person (never for a worker). */
const WAITS =
  /waiting for your (reply|answer|decision|input|choice)|\bi(?:'ll| will) wait for (?:you|your)\b|\blet me know\b|\btell me\b/i;

/** The question the agent's last message asks the person, if it asks one. */
export function agentQuestionOf(screen: string): AgentQuestionRead | undefined {
  const rows = screen.split("\n").map((r) => r.trimEnd());
  // Above the input box, when there is one; else to the end.
  let end = rows.length - 1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (INPUT.test(rows[i] as string)) {
      end = i - 1;
      while (end >= 0 && (RULE.test(rows[end] as string) || (rows[end] as string).trim() === "")) end--;
      break;
    }
  // The trailing status lines and the command the agent waits in are not its message.
  while (end >= 0 && ((rows[end] as string).trim() === "" || NOT_MESSAGE.test(rows[end] as string))) end--;
  if (end < 0) return undefined;
  let start = -1;
  for (let i = end; i >= Math.max(0, end - 60); i--)
    if (MESSAGE.test(rows[i] as string)) {
      start = i;
      break;
    }
  if (start < 0) {
    // No assistant bullets: the rows after the last thing that is not a message.
    start = end;
    while (start > 0 && !NOT_MESSAGE.test(rows[start - 1] as string) && end - start < 40) start--;
  }
  const block = rows.slice(start, end + 1);
  block[0] = (block[0] as string).replace(/^(\s*)●\s/, "$1  ");
  const indent = Math.min(
    ...block.filter((l) => l.trim() !== "").map((l) => (l.match(/^\s*/) as RegExpMatchArray)[0].length),
  );
  const lines = block.map((l) => l.slice(indent));
  const text = lines.join("\n").trim();
  if (text === "") return undefined;
  const options = choicesOf(lines);
  const last =
    lines
      .filter((l) => l.trim() !== "")
      .at(-1)
      ?.trim() ?? "";
  const asks = last.endsWith("?") || (options.length >= 2 && CUE.test(text)) || WAITS.test(text);
  if (!asks) return undefined;
  const sentences = sentencesOf(lines);
  const question = [...sentences].reverse().find((s) => s.endsWith("?"));
  const first = sentences[0] ?? text;
  const prompt =
    options.length >= 2 ? `${first} Which option?` : question && last.endsWith("?") ? question : first;
  return {
    prompt: prompt.length <= PROMPT_MAX ? prompt : `${prompt.slice(0, PROMPT_MAX - 1)}…`,
    text,
    options: options.length >= 2 ? options : [],
  };
}

/** The last list of choices in the message: numbered, lettered or bulleted items (their first line). */
function choicesOf(lines: readonly string[]): { label: string; reply: string }[] {
  let current: { label: string; reply: string }[] = [];
  let last: { label: string; reply: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const numbered = NUMBERED.exec(line) ?? LETTERED.exec(line);
    const bullet = numbered ? undefined : BULLETED.exec(line);
    if (numbered) current.push({ label: line, reply: numbered[1] as string });
    else if (bullet) {
      const item = bullet[1] as string;
      const quoted = /^["“]([^"”]+)["”]/.exec(item);
      current.push({ label: item, reply: quoted ? (quoted[1] as string) : item });
    } else if (line === "" || !raw.startsWith(" ")) {
      // A blank line or a line at the left margin ends a list (an item's own lines are indented).
      if (current.length > 0) last = current;
      current = [];
    }
  }
  return current.length > 0 ? current : last;
}

/** The message's sentences, its wrapped lines joined; a list item is its own sentence. */
function sentencesOf(lines: readonly string[]): string[] {
  const paragraphs: string[] = [];
  let open = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || NUMBERED.test(line) || LETTERED.test(line) || BULLETED.test(line)) {
      if (open) paragraphs.push(open);
      open = "";
      if (line !== "") paragraphs.push(line);
      continue;
    }
    open = open ? `${open} ${line}` : line;
  }
  if (open) paragraphs.push(open);
  return paragraphs.flatMap((p) => p.split(/(?<=[.!?])\s+(?=["“(A-Z0-9])/)).filter((s) => s !== "");
}
