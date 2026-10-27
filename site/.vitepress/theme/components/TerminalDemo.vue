<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/** A terminal replaying a real session (outputs shortened); typed line by line, then repeated. */
const script: { cmd: string; out: string; ok?: boolean }[] = [
  {
    cmd: "metator graph affected --files packages/money/src/index.ts",
    out: '{"ok":true,"data":{"changed":["packages/money/src/index.ts"],"files":[…],"tests":["packages/billing/src/invoice.test.ts"]}}',
  },
  {
    cmd: "metator plan lint .metator/runs/20261026-mt-feature-add-combined-discount/plan.json",
    out: '{"ok":false,"error":{"code":"CHECK_FAILED","message":"1 plan problem(s)","details":{"problems":[{"step":"S2","message":"a created file needs patternSource (an exemplar) or newPatternAdr"}]}}}',
    ok: false,
  },
  {
    cmd: "metator rules check --base main",
    out: '{"ok":false,"error":{"code":"CHECK_FAILED","message":"1 rule violation(s)","details":{"violations":[{"file":"packages/money/src/debug.ts","line":1,"canonRuleId":"SHOP-CODE-001"}]}}}',
    ok: false,
  },
  {
    cmd: 'echo \'{"tool_name":"Bash","tool_input":{"command":"git push"}}\' | metator guard pre-tool',
    out: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"push needs the user\'s approval: …"}}',
    ok: false,
  },
  {
    cmd: "metator run approve push --by alice",
    out: '{"ok":true,"data":{"runId":"20261026-mt-feature-…","approvals":{"push":{"by":"alice",…}}}}',
  },
  {
    cmd: "metator gate full",
    out: '{"ok":true,"data":{"gate":"full","passed":true,"steps":[{"id":"lint","status":"pass"},{"id":"typecheck","status":"pass"},{"id":"test","status":"pass"}]}}',
  },
];

const lines = ref<{ cmd: string; out?: string; ok?: boolean }[]>([]);
const typing = ref("");
let stopped = false;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function play() {
  while (!stopped) {
    lines.value = [];
    for (const step of script) {
      for (let i = 1; i <= step.cmd.length && !stopped; i++) {
        typing.value = step.cmd.slice(0, i);
        await wait(18);
      }
      typing.value = "";
      lines.value.push({ cmd: step.cmd });
      await wait(250);
      (lines.value.at(-1) as { out?: string; ok?: boolean }).out = step.out;
      if (step.ok === false) (lines.value.at(-1) as { ok?: boolean }).ok = false;
      await wait(1100);
      if (lines.value.length > 4) lines.value.shift();
    }
    await wait(2000);
  }
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    lines.value = script.slice(-4).map((s) => ({ ...s }));
    return;
  }
  void play();
});
onBeforeUnmount(() => {
  stopped = true;
});
</script>

<template>
  <div class="mx-term" role="img" aria-label="A terminal session with metator commands and their JSON output">
    <div class="mx-term-bar"><i></i><i></i><i></i><span>~/code/shop</span></div>
    <div class="mx-term-body">
      <div v-for="(l, i) in lines" :key="i" class="mx-term-line">
        <div><span class="p">$</span> {{ l.cmd }}</div>
        <div v-if="l.out" class="out" :class="{ bad: l.ok === false }">{{ l.out }}</div>
      </div>
      <div class="mx-term-line"><span class="p">$</span> {{ typing }}<span class="cursor"></span></div>
    </div>
  </div>
</template>

<style scoped>
.mx-term {
  border-radius: 14px;
  border: 1px solid #30363d;
  background: #0b0f14;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: #e6edf3;
}
.mx-term-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
  color: #8b949e;
  font-size: 12px;
}
.mx-term-bar i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #f87171;
}
.mx-term-bar i:nth-child(2) {
  background: #f0b429;
}
.mx-term-bar i:nth-child(3) {
  background: #4ade80;
}
.mx-term-bar span {
  margin-left: 8px;
}
.mx-term-body {
  padding: 14px 16px;
  min-height: 290px;
}
.mx-term-line {
  margin-bottom: 10px;
  word-break: break-all;
}
.p {
  color: #2dd4bf;
}
.out {
  color: #8b949e;
  margin-top: 3px;
  animation: mx-fade 0.35s ease both;
}
.out.bad {
  color: #fca5a5;
}
@keyframes mx-fade {
  from {
    opacity: 0;
  }
}
.cursor {
  display: inline-block;
  width: 8px;
  height: 15px;
  margin-left: 2px;
  vertical-align: -2px;
  background: #2dd4bf;
  animation: mx-blink 1s steps(1) infinite;
}
@keyframes mx-blink {
  50% {
    opacity: 0;
  }
}
</style>
