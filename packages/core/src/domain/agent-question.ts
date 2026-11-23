import { withoutSidePanel } from "./host-manifest.ts";

/**
 * A question an agent asks the person in its own words, at the end of its turn (ADR-0091): its
 * last message, read from the rendered screen, ends with a question mark, offers numbered,
 * lettered or bulleted choices with a cue to reply, or says it waits for the person. Detection
 * is conservative: a report, a wait for a worker or a summary is no question. A safety net:
 * agents are told to ask with `metator run ask` (a card).
 */
export interface AgentQuestionRead {
  /**
   * The question in one line, in the agent's own words: the question its choices stand under, the
   * one its turn ends with, the first it asks, the sentence that tells the person to answer; when
   * it has no such sentence, its first sentence alone.
   */
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
  /waiting for your (reply|answer|decision|input|choice)|\bi(?:'ll| will) wait for (?:you|your)\b|\bonce you (?:answer|reply|decide|choose)\b/i;
/** After a list, the words that make it a choice: a cue to choose, or "let me know which". */
const WHICH = /\bwhich\b/i;
/**
 * A closing line that asks for nothing in particular: how a greeting or a finished turn hands the
 * word back ("What would you like to work on?", "How can I help?", "Anything else?").
 */
const INVITATION =
  /^(?:so,?\s+)?(?:(?:what|where) (?:would you like|do you want|should we|shall we) (?:me )?(?:to )?(?:work on|start|begin|tackle)\b[^?]*|(?:how|what) (?:can|may|could) i (?:help|do for you)\b[^?]*|what do you need(?: help with)?|anything else\b[^?]*)\?$/i;
/** A bullet labelled as a choice: `(a) Tell the conductor`, `(2) Stop`. */
const LABELLED = /^\(([a-h]|\d{1,2})\)\s/;
/** A bullet that states a fact: `Label: value` (a reply word in quotes is no label). */
const FACT = /^[^:"“”]{2,40}:\s/;
const SENTENCE_END = /(?<=[.!?])\s+(?=["“(A-Z0-9])/;

/** The agent's last message on the screen, its lines as shown (indent taken off). */
interface LastMessage {
  readonly lines: readonly string[];
  readonly text: string;
  /** Its start is not on the screen (a message longer than its pane, another host). */
  readonly cut: boolean;
}

/**
 * The agent's last message on a rendered screen, above its input box, without the status lines
 * under it (a spinner, a tool's output); undefined when the screen shows none.
 */
function lastMessage(screen: string): LastMessage | undefined {
  const rows = withoutSidePanel(screen)
    .split("\n")
    .map((r) => r.trimEnd());
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
  // No start of a message on the screen: another host, or a message longer than its pane.
  const cut = start < 0;
  if (cut) {
    // The rows after the last thing that is not a message.
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
  return text === "" ? undefined : { lines, text, cut };
}

/**
 * The words of the agent's last message on the screen, whatever it says (a question, a report, a
 * tool call); undefined when the screen shows none (cleared, mid-redraw).
 */
export function lastMessageOf(screen: string): string | undefined {
  return lastMessage(screen)?.text;
}

/** The question the agent's last message asks the person, if it asks one. */
export function agentQuestionOf(screen: string): AgentQuestionRead | undefined {
  const last = lastMessage(screen);
  if (!last) return undefined;
  const { lines, text, cut } = last;
  // A cut message begins inside something: the lines under an item that scrolled off say nothing alone.
  const margin = cut ? lines.findIndex((l) => l !== "" && !l.startsWith(" ")) : 0;
  const parts = partsOf(lines.slice(Math.max(0, margin)));
  const prose = parts.flatMap((p) => (p.item ? [] : p.sentences));
  // The last list, the sentence that introduces it and what is said after it.
  let to = parts.length - 1;
  while (to >= 0 && !parts[to]?.item) to--;
  let from = to;
  while (from > 0 && parts[from - 1]?.item) from--;
  const items = to < 0 ? [] : parts.slice(from, to + 1);
  const list = items.map((p) => p.item as Item);
  const intro = from > 0 ? parts[from - 1]?.sentences.at(-1) : undefined;
  const after = to < 0 ? [] : parts.slice(to + 1).flatMap((p) => p.sentences);
  const under = intro?.endsWith("?") ? intro : undefined;
  const cueBefore = intro !== undefined && (under !== undefined || CHOOSE.test(intro));
  const cueAfter = after.some((x) => CHOOSE.test(x) || (ANSWER_ME.test(x) && WHICH.test(x)));
  const said = items.map((p) => p.sentences);
  // Items that are themselves questions are no choices: the person answers them in words.
  const plain = said.every((item) => !item.some((x) => x.endsWith("?")));
  // Without a question or a cue above them, items that explain at length or state facts
  // (`Label: value` bullets) are a report, whatever is said after them.
  const brief = said.every((item) => item.length <= 2) && !list.every((i) => i.bullet && FACT.test(i.text));
  const options =
    list.length >= 2 && plain && (cueBefore || (cueAfter && brief)) ? list.map((i) => i.option) : [];
  const closing = parts.at(-1)?.sentences.at(-1) ?? "";
  // A turn that ends with a question asks, unless it only hands the word back.
  const ends = closing.endsWith("?") && !(parts.at(-1)?.item === undefined && INVITATION.test(closing));
  // "Say yes and …", "Tell me how to go on.", "Still waiting for your reply": the turn ends on the person.
  const telling = prose.find((x) => ANSWER_ME.test(x) || WAITS.test(x));
  const waits = telling !== undefined || said.some((item) => item.some((x) => WAITS.test(x)));
  // A question with a list under it: the list is what the question is about.
  const asks = ends || options.length >= 2 || waits || (list.length >= 2 && under !== undefined);
  if (!asks) return undefined;
  // How the message begins: never the tail of a sentence whose start scrolled off.
  const first = (cut && prose.length > 1 && /^[a-z]/.test(prose[0] as string) ? prose[1] : prose[0]) ?? text;
  const prompt =
    under ??
    (ends && !parts.at(-1)?.item ? closing : undefined) ??
    prose.find((x) => x.endsWith("?")) ??
    (ends ? closing : undefined) ??
    (options.length >= 2 ? first : (telling ?? first));
  return {
    prompt: prompt.length <= PROMPT_MAX ? prompt : `${prompt.slice(0, PROMPT_MAX - 1)}…`,
    text,
    options,
  };
}

interface Item {
  /** The item's whole text: its first line and the lines under it (wrapped lines, sub-items). */
  text: string;
  bullet: boolean;
  option: { label: string; reply: string };
}

/** A paragraph of the message as its sentences, or one item of a list. */
interface Part {
  readonly sentences: readonly string[];
  readonly item?: Item;
}

/** A line that begins an item: numbered, lettered or bulleted. */
function itemOf(line: string): Item | undefined {
  const numbered = NUMBERED.exec(line) ?? LETTERED.exec(line);
  if (numbered)
    return {
      text: numbered[2] as string,
      bullet: false,
      option: { label: line, reply: numbered[1] as string },
    };
  const bullet = BULLETED.exec(line);
  if (!bullet) return undefined;
  const item = bullet[1] as string;
  // What is typed for a bullet: the word it quotes, its label's letter, else its line.
  const key = /^["“]([^"”]+)["”]/.exec(item) ?? LABELLED.exec(item);
  return { text: item, bullet: true, option: { label: item, reply: key ? (key[1] as string) : item } };
}

/**
 * The message in order: its paragraphs (wrapped lines joined, split into sentences) and its
 * items. A line indented under an item is that item's (a wrapped line, a sub-item), never a
 * sentence of its own; blank lines between items do not end their list.
 */
function partsOf(lines: readonly string[]): Part[] {
  const parts: Part[] = [];
  let paragraph = "";
  let open: { readonly item: Item; readonly indent: number } | undefined;
  const flush = () => {
    if (paragraph !== "") parts.push({ sentences: sentencesOf(paragraph) });
    paragraph = "";
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const item = itemOf(line);
    if (item && (!open || indent <= open.indent)) {
      flush();
      open = { item, indent };
      parts.push({ sentences: [], item });
    } else if (open && indent > open.indent) open.item.text = `${open.item.text} ${line}`;
    else {
      open = undefined;
      paragraph = paragraph === "" ? line : `${paragraph} ${line}`;
    }
  }
  flush();
  // An item's sentences, once the lines under it are its own.
  return parts.map((p) => (p.item ? { ...p, sentences: sentencesOf(p.item.text) } : p));
}

const sentencesOf = (text: string): string[] =>
  text
    .split(SENTENCE_END)
    .map((x) => x.trim())
    .filter((x) => x !== "");
