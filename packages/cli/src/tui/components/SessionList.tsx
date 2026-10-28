import { Box, Text } from "ink";
import { ATTENTION, fit, type Row } from "../model.ts";

/** The left pane: runs by repository (who must act first), then the conversations. */
export function SessionList(props: {
  readonly rows: readonly Row[];
  readonly selected: string | undefined;
  readonly width: number;
  readonly height: number;
}) {
  const { rows, selected, width, height } = props;
  const at = Math.max(
    0,
    rows.findIndex((r) => r.kind !== "heading" && r.key === selected),
  );
  // Keep the selection in view: scroll so it sits in the visible window.
  const start = Math.max(0, Math.min(at - Math.floor(height / 2), rows.length - height));
  const visible = rows.slice(start, start + height);
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="gray">
        SESSIONS
      </Text>
      {rows.length === 0 ? <Text dimColor>No runs yet. n: new run · ?: ask</Text> : null}
      {visible.map((r) => {
        if (r.kind === "heading")
          return (
            <Text key={`h-${r.text}`} bold color="blue">
              {fit(r.text, width - 4)}
            </Text>
          );
        const on = r.key === selected;
        if (r.kind === "chat")
          return (
            <Text key={r.key} {...(on ? { inverse: true } : {})}>
              <Text color="magenta">✦ </Text>
              {fit(r.chat.title, width - 6)}
            </Text>
          );
        const a = ATTENTION[r.run.attention];
        const label = r.run.task || r.run.runId;
        return (
          <Text key={r.key} {...(on ? { inverse: true } : {})}>
            <Text color={a.color}>{a.icon} </Text>
            {fit(label, width - 6 - r.run.stage.length - 3)}
            <Text dimColor> · {r.run.stage}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
