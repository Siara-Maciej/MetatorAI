import type { RunActivity, RunOverview } from "@metator/core";
import { Box, Text } from "ink";
import { ATTENTION, duration, fit, nextStep, stageBar } from "../model.ts";

export type Tab = "overview" | "activity" | "apps";
export const TABS: readonly Tab[] = ["overview", "activity", "apps"];

/** The right pane for a run: what it needs now, its stages, then the chosen tab. */
export function RunDetail(props: {
  readonly run: RunOverview;
  readonly repoName?: string;
  readonly tab: Tab;
  readonly activity: readonly RunActivity[];
  readonly width: number;
  readonly height: number;
}) {
  const { run, tab, width } = props;
  const a = ATTENTION[run.attention];
  const inner = width - 4;
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={a.color} paddingX={1}>
      <Text bold>{fit(run.task, inner)}</Text>
      <Text dimColor>
        {fit(
          [
            run.runId,
            props.repoName,
            run.workflow,
            run.autonomy,
            run.host ?? "no host yet",
            duration(run.elapsedMs),
          ]
            .filter(Boolean)
            .join(" · "),
          inner,
        )}
      </Text>
      <Box marginTop={1}>
        <Text color={a.color} bold>
          {a.icon} {a.label}
        </Text>
        <Text> · {fit(nextStep(run), inner - a.label.length - 5)}</Text>
      </Box>
      <Text wrap="wrap">{stageBar(run.stages)}</Text>
      <Box marginTop={1}>
        {TABS.map((t) => (
          <Text key={t} {...(t === tab ? { inverse: true, bold: true } : { dimColor: true })}>
            {` ${t === "overview" ? "Overview" : t === "activity" ? "Activity" : "Apps"} `}
          </Text>
        ))}
        <Text dimColor> (tab)</Text>
      </Box>
      {tab === "overview" ? <Overview run={run} width={inner} /> : null}
      {tab === "activity" ? (
        <Activity items={props.activity} width={inner} height={Math.max(3, props.height - 9)} />
      ) : null}
      {tab === "apps" ? <Apps run={run} width={inner} /> : null}
    </Box>
  );
}

function Overview({ run, width }: { readonly run: RunOverview; readonly width: number }) {
  return (
    <Box flexDirection="column">
      {run.questions.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">
            Questions for you ({run.questions.length})
          </Text>
          {run.questions.map((q) => (
            <Text key={q.id}>
              <Text color="yellow">{q.id} </Text>
              <Text dimColor>
                {q.stage}
                {q.agent ? ` · ${q.agent}` : ""} · {q.source}:{" "}
              </Text>
              {fit(q.prompt, width - 24)}
            </Text>
          ))}
          <Text dimColor>a: answer</Text>
        </Box>
      ) : null}
      {run.last ? (
        <Text>
          <Text dimColor>last: </Text>
          {fit(
            `${run.last.at.slice(11, 19)} ${run.last.agent ?? run.last.stage ?? ""} ${run.last.text}`,
            width - 6,
          )}
        </Text>
      ) : null}
      {run.worktree ? (
        <Text>
          <Text dimColor>worktree: </Text>
          {fit(
            `${run.worktree.branch}${run.worktree.ports ? ` · ports ${run.worktree.ports.from}–${run.worktree.ports.from + run.worktree.ports.count - 1}` : ""}`,
            width - 10,
          )}
        </Text>
      ) : (
        <Text dimColor>works in this checkout</Text>
      )}
      <Text dimColor>e: editor · t: shell · d: diff · c: continue · x: stop the drive</Text>
    </Box>
  );
}

function Activity(props: {
  readonly items: readonly RunActivity[];
  readonly width: number;
  readonly height: number;
}) {
  const shown = props.items.slice(-props.height);
  if (shown.length === 0) return <Text dimColor>Nothing has happened yet.</Text>;
  return (
    <Box flexDirection="column">
      {shown.map((e) => (
        <Text key={`${e.at}-${e.type}-${e.agent ?? e.stage ?? ""}-${e.text.slice(0, 40)}`}>
          <Text dimColor>{e.at.slice(11, 19)} </Text>
          <Text color={e.type === "error" ? "red" : e.type === "question" ? "yellow" : "white"}>
            {fit(`${e.agent ?? e.stage ?? e.type} ${e.text}`, props.width - 10)}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function Apps({ run, width }: { readonly run: RunOverview; readonly width: number }) {
  if (!run.worktree)
    return <Text dimColor>The run works in this checkout: start its apps with `metator env up`.</Text>;
  return (
    <Box flexDirection="column">
      {run.services.length === 0 ? <Text dimColor>No environment (metator/environment.yml).</Text> : null}
      {run.services.map((s) => (
        <Text key={s.service}>
          <Text color={s.status === "running" ? "green" : "gray"}>{s.status === "running" ? "●" : "○"} </Text>
          {fit(
            `${s.service} · ${s.scope} · ${
              Object.entries(s.ports)
                .map(([n, p]) => `${n} :${p}`)
                .join(", ") || "no ports"
            }`,
            width - 2,
          )}
        </Text>
      ))}
      <Text dimColor>u: start all · w: stop all</Text>
    </Box>
  );
}
