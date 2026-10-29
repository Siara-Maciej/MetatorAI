import type { Conversation } from "@metator/core";
import { Box, Text } from "ink";
import { fit } from "../model.ts";

/** A conversation with mt-guide: questions and answers, citations flagged when their file is missing. */
export function ChatView(props: {
  readonly conversation: Conversation | null;
  /** The answer arriving right now, line by line. */
  readonly pending?: { readonly question: string; readonly text: string };
  readonly width: number;
  readonly height: number;
}) {
  const { conversation, pending, width } = props;
  const inner = width - 4;
  const turns = conversation?.turns ?? [];
  // Show the most recent turns that fit; older ones are a scroll away in `metator ask list`.
  const shown = turns.slice(-Math.max(1, Math.floor(props.height / 6)));
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold>{fit(conversation?.title ?? pending?.question ?? "New question", inner)}</Text>
      <Text dimColor>
        {conversation
          ? `${conversation.id} · ${conversation.host} · ${turns.length} question(s)`
          : "mt-guide reads the code and cites path:line"}
      </Text>
      {shown.map((t) => (
        <Box key={t.at} flexDirection="column" marginTop={1}>
          <Text color="magenta" bold>
            › {t.question}
          </Text>
          <Text wrap="wrap">{t.answer || (t.ok ? "" : "(no answer: the host failed)")}</Text>
          {t.citations.some((c) => !c.exists) ? (
            <Text color="yellow">
              ⚠ cites files that do not exist:{" "}
              {t.citations
                .filter((c) => !c.exists)
                .map((c) => `${c.path}:${c.line}`)
                .join(", ")}
            </Text>
          ) : null}
        </Box>
      ))}
      {pending ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta" bold>
            › {pending.question}
          </Text>
          <Text wrap="wrap">{pending.text || "…"}</Text>
        </Box>
      ) : null}
      <Text dimColor>r: follow-up · ?: new question</Text>
    </Box>
  );
}
