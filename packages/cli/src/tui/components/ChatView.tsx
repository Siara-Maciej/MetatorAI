import type { Conversation } from "@metator/core";
import { Box, Text } from "ink";
import { fit, maxScroll, wrappedLines } from "../model.ts";

type Turn = Conversation["turns"][number];

const answerOf = (t: Turn) => t.answer || (t.ok ? "" : "(no answer: the host failed)");

const missing = (t: Turn) =>
  t.citations
    .filter((c) => !c.exists)
    .map((c) => `${c.path}:${c.line}`)
    .join(", ");

const warningOf = (t: Turn) =>
  t.citations.some((c) => !c.exists) ? `⚠ cites files that do not exist: ${missing(t)}` : "";

/** Lines the title, the meta line, the hint line and the border take around the turns. */
const CHROME = 5;

export interface ChatLayout {
  /** Lines of the turns, wrapped to the pane. */
  readonly lines: number;
  /** Lines the pane shows at once. */
  readonly rows: number;
  /** Where the view starts unless the person scrolled: the latest question (or, while an answer
   * arrives, its end). */
  readonly start: number;
  readonly max: number;
}

/** How a conversation lays out in a pane of the given size: what scrolling it needs. */
export function chatLayout(
  conversation: Conversation | null,
  pending: { readonly question: string; readonly text: string } | undefined,
  width: number,
  height: number,
): ChatLayout {
  const inner = width - 4;
  const rows = Math.max(1, height - CHROME);
  const turnLines = (question: string, answer: string, warning: string) =>
    1 +
    wrappedLines(`› ${question}`, inner) +
    wrappedLines(answer, inner) +
    (warning ? wrappedLines(warning, inner) : 0);
  const turns = conversation?.turns ?? [];
  const sizes = turns.map((t) => turnLines(t.question, answerOf(t), warningOf(t)));
  const before = sizes.slice(0, -1).reduce((n, s) => n + s, 0);
  const lines =
    sizes.reduce((n, s) => n + s, 0) + (pending ? turnLines(pending.question, pending.text || "…", "") : 0);
  const max = maxScroll(lines, rows);
  return { lines, rows, start: Math.min(pending ? max : before, max), max };
}

/** A conversation with mt-guide: questions and answers, citations flagged when their file is missing. */
export function ChatView(props: {
  readonly conversation: Conversation | null;
  /** The answer arriving right now, line by line. */
  readonly pending?: { readonly question: string; readonly text: string };
  readonly width: number;
  readonly height: number;
  /** The first line shown; by default the latest question. */
  readonly scroll?: number;
}) {
  const { conversation, pending, width } = props;
  const inner = width - 4;
  const turns = conversation?.turns ?? [];
  const layout = chatLayout(conversation, pending ?? undefined, width, props.height);
  const top = Math.min(layout.max, Math.max(0, props.scroll ?? layout.start));
  const below = Math.max(0, layout.lines - top - layout.rows);
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold>{fit(conversation?.title ?? pending?.question ?? "New question", inner)}</Text>
      <Text dimColor>
        {conversation
          ? `${conversation.id} · ${conversation.host} · ${turns.length} question(s)`
          : "mt-guide reads the code and cites path:line"}
      </Text>
      <Box height={layout.rows} overflow="hidden" flexDirection="column">
        <Box flexDirection="column" marginTop={-top} flexShrink={0}>
          {turns.map((t) => (
            <Box key={t.at} flexDirection="column" marginTop={1} flexShrink={0}>
              <Text color="magenta" bold>
                › {t.question}
              </Text>
              <Text wrap="wrap">{answerOf(t)}</Text>
              {warningOf(t) ? <Text color="yellow">{warningOf(t)}</Text> : null}
            </Box>
          ))}
          {pending ? (
            <Box flexDirection="column" marginTop={1} flexShrink={0}>
              <Text color="magenta" bold>
                › {pending.question}
              </Text>
              <Text wrap="wrap">{pending.text || "…"}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
      <Text dimColor>
        {layout.max > 0 ? `PgUp/PgDn scroll${below > 0 ? ` (${below} more lines)` : ""} · ` : ""}r: follow-up
        · ?: new question
      </Text>
    </Box>
  );
}
