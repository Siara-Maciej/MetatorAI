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
/**
 * Words that ask the person to choose among what is listed: an `Options:` label, "reply with",
 * "pick one". A bare "pick" or "which" is none ("no commit will pick it up", "which matches").
 */
const CHOOSE =
  /^\s*(?:options|choices)\s*:|\breply (?:with|in|by)\b|\b(?:choose|pick|select) (?:one|between|from|which)\b|\bwhich (?:one|option)\b/im;
/**
 * A sentence that tells the person to answer: it begins with the word ("Say yes and …", "Let me
 * know which"). A conditional is no such thing ("let me know if …", "tell me if anything …").
 */
const ANSWER_ME =
  /^(?:please\s+)?(?:say|reply|answer|confirm|choose|pick|select|tell me|let me know)\b(?!,?\s+(?:if|when|once)\b)/i;
/** What says the agent waits for the person (never for a worker). */
const WAITS =
  /waiting for your (reply|answer|decision|input|choice)|\bi(?:'ll| will) wait for (?:you|your)\b/i;
/** A bullet that states a fact: `Label: value` (a reply word in quotes is no label). */
const FACT = /^[^:"“”]{2,40}:\s/;
const SENTENCE_END = /(?<=[.!?])\s+(?=["“(A-Z0-9])/;

/**
 * The rows without a panel drawn at their right (Claude Code's diff panel): when most rows have
 * the border `│` in one column, everything from that column on is no part of the message.
 */
function withoutSidePanel(rows: readonly string[]): string[] {
  const columns = new Map<number, number>();
  let bordered = 0;
  for (const row of rows) {
    const at = row.indexOf("│");
    if (at < 0) continue;
    bordered++;
    for (let i = at; i >= 0; i = row.indexOf("│", i + 1)) columns.set(i, (columns.get(i) ?? 0) + 1);
  }
  const [column, count] = [...columns.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [-1, 0];
  // A column only a few rows share is a character of the text, not a border.
  if (column < 20 || count < 3 || count < bordered / 2) return [...rows];
  return rows.map((row) => (row[column] === "│" ? row.slice(0, column).trimEnd() : row));
}

/** The question the agent's last message asks the person, if it asks one. */
export function agentQuestionOf(screen: string): AgentQuestionRead | undefined {
  const rows = withoutSidePanel(screen.split("\n").map((r) => r.trimEnd()));
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
  const items = itemsOf(lines);
  const sentences = sentencesOf(lines);
  const question = (list: readonly string[]) => list.find((x) => x.endsWith("?"));
  const hasQuestion = text.includes("?");
  // Items that are themselves questions, or run over several sentences, are no choices: the
  // person answers them in words.
  const choices = items.every((i) => {
    const said = i.text.split(SENTENCE_END);
    return !said.some((x) => x.trim().endsWith("?")) && said.length <= 2;
  });
  // Bullets of `Label: value` under no question are facts of a report.
  const facts = !hasQuestion && items.length > 0 && items.every((i) => i.bullet && FACT.test(i.text));
  const options = choices && !facts && items.length >= 2 ? items.map((i) => i.option) : [];
  const last =
    lines
      .filter((l) => l.trim() !== "")
      .at(-1)
      ?.trim() ?? "";
  const toldToAnswer = sentences.some((x) => ANSWER_ME.test(x));
  const outside = sentences.filter((x) => !ITEM.test(x));
  const asks =
    last.endsWith("?") ||
    (options.length >= 2 && (CHOOSE.test(text) || hasQuestion)) ||
    // "Say yes and …", "Tell me how to go on.": the turn ends on the person.
    toldToAnswer ||
    // A question, then a list under it: the list is what the question is about.
    (items.length >= 2 && outside.some((x) => x.endsWith("?"))) ||
    WAITS.test(text);
  if (!asks) return undefined;
  const first = sentences[0] ?? text;
  // The question the turn ends with; else the first one it asks; else how it begins.
  const asked = last.endsWith("?") ? question([...sentences].reverse()) : question(outside);
  const prompt = options.length >= 2 ? `${first} Which option?` : (asked ?? first);
  return {
    prompt: prompt.length <= PROMPT_MAX ? prompt : `${prompt.slice(0, PROMPT_MAX - 1)}…`,
    text,
    options,
  };
}

const ITEM = /^(?:\d{1,2}[.)]|[a-h][.)]|[-•*])\s+/;

interface Item {
  /** The item's whole text: its first line and the indented lines under it. */
  text: string;
  bullet: boolean;
  option: { label: string; reply: string };
}

/** The last list in the message: numbered, lettered or bulleted items, each with its whole text. */
function itemsOf(lines: readonly string[]): Item[] {
  let current: Item[] = [];
  let last: Item[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const numbered = NUMBERED.exec(line) ?? LETTERED.exec(line);
    const bullet = numbered ? undefined : BULLETED.exec(line);
    if (numbered)
      current.push({
        text: numbered[2] as string,
        bullet: false,
        option: { label: line, reply: numbered[1] as string },
      });
    else if (bullet) {
      const item = bullet[1] as string;
      const quoted = /^["“]([^"”]+)["”]/.exec(item);
      current.push({
        text: item,
        bullet: true,
        option: { label: item, reply: quoted ? (quoted[1] as string) : item },
      });
    } else if (line === "" || !raw.startsWith(" ")) {
      // A blank line or a line at the left margin ends a list (an item's own lines are indented).
      if (current.length > 0) last = current;
      current = [];
    } else if (current.length > 0) {
      const open = current[current.length - 1] as Item;
      open.text = `${open.text} ${line}`;
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
  return paragraphs.flatMap((p) => p.split(SENTENCE_END)).filter((s) => s !== "");
}
