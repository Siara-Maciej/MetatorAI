/**
 * Generates the animated README visuals (CSS + SMIL, no JavaScript, so they animate on GitHub).
 * Usage: bun scripts/assets/generate.ts [outDir]    (default: assets/)
 * Deterministic output: e2e/assets.e2e.test.ts fails if committed SVGs drift from this generator.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const C = {
  bg: "#0d1117",
  panel: "#161b22",
  lit: "#1f2630",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  gold: "#f0b429",
  teal: "#2dd4bf",
  violet: "#a78bfa",
  red: "#f87171",
  green: "#4ade80",
} as const;

const DEFS = `
  <defs>
    <filter id="glow" x="-200%" y="-200%" width="500%" height="500%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg}"/><stop offset="1" stop-color="#111827"/>
    </linearGradient>
  </defs>`;

const round = (n: number, digits = 4) => Number(n.toFixed(digits));
const pct = (t: number, dur: number) => round((100 * t) / dur, 3);
const kt = (t: number, dur: number) => round(Math.max(0, Math.min(1, t / dur)));

/** Dot invisible until t0, travelling the path t0→t1, fading out after t1. */
export function packet(path: string, t0: number, t1: number, color: string, dur: number, r = 5, opacity = 1) {
  const a = kt(t0, dur);
  const b = kt(t1, dur);
  let a0 = kt(Math.max(t0 - 0.05, 0.01), dur);
  const b1 = kt(Math.min(t1 + 0.15, dur - 0.01), dur);
  if (a0 >= a) a0 = round(a - 0.001);
  return `
    <circle r="${r}" fill="${color}" filter="url(#glow)" opacity="0" fill-opacity="${opacity}">
      <animateMotion dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyPoints="0;0;1;1" keyTimes="0;${a};${b};1" path="${path}"/>
      <animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="0;${a0};${a};${b};${b1};1"/>
    </circle>`;
}

/** CSS keyframes holding `on` styles between tOn and tOff inside a loop of `dur` seconds. */
export function windowKeyframes(
  name: string,
  tOn: number,
  tOff: number,
  dur: number,
  on: string,
  off: string,
) {
  const pOn = pct(tOn, dur);
  const pOff = pct(tOff, dur);
  const pOn0 = Math.max(round(pOn - 1.5, 3), 0);
  const pOff1 = Math.min(round(pOff + 3, 3), 100);
  return `@keyframes ${name} { 0%, ${pOn0}% { ${off} } ${pOn}%, ${pOff}% { ${on} } ${pOff1}%, 100% { ${off} } }`;
}

function frame(w: number, h: number, label: string, title: string, css: string[], body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">
  <title>${title}</title>${DEFS}
  <style>${css.join(" ")}</style>
  <rect width="${w}" height="${h}" rx="18" fill="url(#bgGrad)" stroke="${C.border}"/>
  ${body}
</svg>
`;
}

const text = (x: number, y: number, size: number, fill: string, content: string, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${SANS}" font-size="${size}" fill="${fill}" ${extra}>${content}</text>`;
const mono = (x: number, y: number, size: number, fill: string, content: string, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" fill="${fill}" ${extra}>${content}</text>`;

// ─────────────────────────────────────────────────────────────────── hero.svg
export function hero(): string {
  const dur = 9;
  const W = 960;
  const H = 270;
  const gx = 40;
  const gy = 35;
  const gs = 200;
  const n = 6;
  const step = gs / n;
  const css: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i <= n; i++) {
    const d = round(i * step, 2);
    lines.push(`<line class="gl v${i}" x1="${gx + d}" y1="${gy}" x2="${gx + d}" y2="${gy + gs}"/>`);
    lines.push(`<line class="gl h${i}" x1="${gx}" y1="${gy + d}" x2="${gx + gs}" y2="${gy + d}"/>`);
    const t0 = 0.2 + i * 0.18;
    css.push(
      windowKeyframes(
        `draw${i}`,
        t0 + 0.9,
        dur - 0.8,
        dur,
        "stroke-dashoffset: 0; opacity: 1",
        `stroke-dashoffset: ${gs}; opacity: .9`,
      ),
      `.v${i}, .h${i} { animation: draw${i} ${dur}s ease-in-out infinite; }`,
    );
  }
  const cells: [number, number, string][] = [
    [1, 1, C.gold],
    [3, 1, C.teal],
    [4, 3, C.violet],
    [1, 4, C.teal],
    [5, 1, C.gold],
    [4, 4, C.gold],
    [5, 5, C.green],
    [0, 2, C.violet],
  ];
  const units = cells.map(([cx, cy, col], k) => {
    css.push(
      windowKeyframes(
        `unit${k}`,
        2.6 + k * 0.32,
        dur - 0.9,
        dur,
        "opacity: 1; transform: scale(1)",
        "opacity: 0; transform: scale(.4)",
      ),
      `.u${k} { transform-box: fill-box; transform-origin: center; animation: unit${k} ${dur}s ease-out infinite; }`,
    );
    const x = round(gx + cx * step + 6, 1);
    const y = round(gy + cy * step + 6, 1);
    return `<rect class="u${k}" x="${x}" y="${y}" width="${round(step - 12, 1)}" height="${round(step - 12, 1)}" rx="4" fill="${col}" fill-opacity=".85"/>`;
  });
  const cx = gx + gs / 2;
  const cy = gy + gs / 2;
  const bobs = [
    [cx - 26, cy],
    [cx + 26, cy],
    [cx, cy - 26],
    [cx, cy + 26],
  ]
    .map(
      ([x, y]) =>
        `<line x1="${x}" y1="${y}" x2="${x}" y2="${(y as number) + 9}" stroke-width="1"/><circle cx="${x}" cy="${(y as number) + 11}" r="2.2" fill="${C.text}" stroke="none"/>`,
    )
    .join("");
  const groma = `
    <g class="groma" stroke="${C.text}" stroke-width="2" fill="none" opacity=".9">
      <line x1="${cx - 26}" y1="${cy}" x2="${cx + 26}" y2="${cy}"/>
      <line x1="${cx}" y1="${cy - 26}" x2="${cx}" y2="${cy + 26}"/>
      <circle cx="${cx}" cy="${cy}" r="3.5" fill="${C.gold}" stroke="none"/>${bobs}
    </g>`;
  css.push(
    "@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(90deg); } }",
    `.groma { transform-origin: ${cx}px ${cy}px; animation: spin ${dur}s cubic-bezier(.7,0,.3,1) infinite; }`,
    "@keyframes blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }",
    ".cursor { animation: blink 1s steps(1) infinite; }",
    `.gl { stroke: ${C.border}; stroke-width: 1.2; stroke-dasharray: ${gs}; stroke-dashoffset: ${gs}; }`,
  );
  const tx = 300;
  /** Clip end must exceed the tagline width in the widest font (asserted by e2e/assets.e2e.test.ts). */
  const typeW = 480;
  const a = kt(0.6, dur);
  const b = kt(3.0, dur);
  const c = kt(dur - 0.6, dur);
  const body = `
    <linearGradient id="titleGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.gold}"/><stop offset=".5" stop-color="#fde68a"/><stop offset="1" stop-color="${C.teal}"/>
      <animateTransform attributeName="gradientTransform" type="translate" values="-0.6 0;0.6 0;-0.6 0" dur="${dur}s" repeatCount="indefinite"/>
    </linearGradient>
    <clipPath id="typeClip">
      <rect x="${tx}" y="128" height="40" width="0">
        <animate attributeName="width" dur="${dur}s" repeatCount="indefinite" values="0;0;${typeW};${typeW};0" keyTimes="0;${a};${b};${c};1"/>
      </rect>
    </clipPath>
  <g>${lines.join("")}</g>
  <g>${units.join("")}</g>
  ${groma}
  ${text(tx, 104, 66, "url(#titleGrad)", "MetatorAI", 'font-weight="800" letter-spacing="-1.5"')}
  ${text(tx, 158, 26, C.text, "Lay out the ground. Then build.", 'font-weight="600" clip-path="url(#typeClip)"')}
  <g opacity="0">
    <animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;${a};${b};${kt(3.2, dur)};1"/>
    <rect class="cursor" x="${tx}" y="135" width="3" height="28" fill="${C.gold}">
      <animate attributeName="x" dur="${dur}s" repeatCount="indefinite" values="${tx};${tx};${tx + typeW};${tx + typeW};${tx}" keyTimes="0;${a};${b};${c};1"/>
    </rect>
  </g>
  ${text(tx, 198, 16, C.muted, "Agentic engineering for GitHub Copilot &amp; Claude Code.")}
  ${text(tx, 222, 16, C.muted, "Survey first. Prove everything.")}
  ${mono(tx, 250, 12, C.muted, "survey · plan · gate · build · verify · ship", 'opacity=".8"')}`;
  return frame(
    W,
    H,
    "MetatorAI: Lay out the ground. Then build.",
    "MetatorAI: Lay out the ground. Then build.",
    css,
    body,
  );
}

// ─────────────────────────────────────────────────────────────────── flow.svg
export function flow(): string {
  const dur = 10;
  const W = 960;
  const H = 420;
  const cards: [string, string, string, string][] = [
    ["01", "SURVEY", "graph · patterns", "rules from ADRs"],
    ["02", "PLAN", "every step cites", "a real exemplar"],
    ["03", "GATE", "plan lint + critic", "+ your approval"],
    ["04", "BUILD", "tests RED → GREEN", "inside plan scope"],
    ["05", "VERIFY", "find → refute", "→ judge"],
    ["06", "SHIP", "PR only after", "a human says go"],
  ];
  const cw = 128;
  const ch = 96;
  const cy0 = 120;
  const gap = 26;
  const x0 = 32;
  const rail = 252;
  const travel = 8.0;
  const arrive = cards.map((_, k) => round((travel * k) / 5, 3));
  const css: string[] = [
    `.card { fill: ${C.panel}; stroke: ${C.border}; stroke-width: 1.5; }`,
    `.chip { fill: ${C.panel}; stroke: ${C.border}; }`,
    ".flowdash { stroke-dasharray: 4 6; animation: dash 1.2s linear infinite; }",
    "@keyframes dash { to { stroke-dashoffset: -20; } }",
  ];
  const body: string[] = [];
  const cardX = (k: number) => x0 + k * (cw + gap);
  cards.forEach(([num, title, s1, s2], k) => {
    const x = cardX(k);
    const cx = x + cw / 2;
    const t = arrive[k] as number;
    css.push(
      windowKeyframes(
        `lit${k}`,
        t,
        t + 1.1,
        dur,
        `fill: ${C.lit}; stroke: ${C.gold}`,
        `fill: ${C.panel}; stroke: ${C.border}`,
      ),
      `.c${k} { animation: lit${k} ${dur}s linear infinite; }`,
      windowKeyframes(`chk${k}`, t + 0.15, dur - 0.5, dur, "opacity: 1", "opacity: 0"),
      `.k${k} { animation: chk${k} ${dur}s linear infinite; }`,
      windowKeyframes(`node${k}`, t, t + 0.6, dur, `fill: ${C.gold}; r: 7px`, `fill: ${C.border}; r: 5px`),
      `.n${k} { animation: node${k} ${dur}s linear infinite; }`,
    );
    body.push(`
  <rect class="card c${k}" x="${x}" y="${cy0}" width="${cw}" height="${ch}" rx="12"/>
  ${mono(x + 14, cy0 + 24, 11, C.gold, num)}
  ${text(x + 14, cy0 + 50, 16, C.text, title, 'font-weight="700" letter-spacing=".5"')}
  ${text(x + 14, cy0 + 71, 11, C.muted, s1)}
  ${text(x + 14, cy0 + 85, 11, C.muted, s2)}
  <g class="k${k}" opacity="0">
    <circle cx="${x + cw - 18}" cy="${cy0 + 20}" r="9" fill="${C.green}" fill-opacity=".18" stroke="${C.green}"/>
    <path d="M${x + cw - 22.5} ${cy0 + 20} l3 3 l6 -6" stroke="${C.green}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <line x1="${cx}" y1="${cy0 + ch}" x2="${cx}" y2="${rail}" stroke="${C.border}" stroke-width="1.5"/>
  <circle class="n${k}" cx="${cx}" cy="${rail}" r="5" fill="${C.border}"/>`);
  });
  const firstCx = cardX(0) + cw / 2;
  const lastCx = cardX(5) + cw / 2;
  const railPath = `M${firstCx},${rail} L${lastCx},${rail}`;
  body.unshift(`<path d="${railPath}" stroke="${C.border}" stroke-width="2" fill="none"/>`);
  body.push(
    `<path d="${railPath}" stroke="${C.gold}" stroke-opacity=".35" stroke-width="2" fill="none" class="flowdash"/>`,
  );
  for (const [lag, r, op] of [
    [0, 7, 1],
    [0.12, 4.5, 0.55],
    [0.24, 3, 0.3],
  ] as const) {
    body.push(packet(railPath, 0.06 + lag, travel + lag, C.gold, dur, r, op));
  }

  const chips = (
    labels: string[],
    center: number,
    cardCx: number,
    tOn: number,
    tOff: number,
    cls: string,
    colors: string[],
  ) => {
    const out: string[] = [];
    const widths = labels.map((s) => round(s.length * 6.6 + 18, 1));
    const total = widths.reduce((s, w) => s + w, 0) + 8 * (labels.length - 1);
    let x = center - total / 2;
    labels.forEach((label, i) => {
      const w = widths[i] as number;
      const col = colors[i] as string;
      const name = `${cls}${i}`;
      css.push(
        windowKeyframes(
          name,
          tOn + i * 0.12,
          tOff,
          dur,
          `stroke: ${col}; fill: ${col}22`,
          `stroke: ${C.border}; fill: ${C.panel}`,
        ),
        `.${name} { animation: ${name} ${dur}s linear infinite; }`,
      );
      const mx = round(x + w / 2, 1);
      out.push(
        `<rect class="chip ${name}" x="${round(x, 1)}" y="66" width="${w}" height="24" rx="12"/>`,
        mono(mx, 82, 11, C.text, label, 'text-anchor="middle"'),
        `<path d="M${mx},90 C${mx},106 ${cardCx},104 ${cardCx},${cy0}" stroke="${C.border}" class="flowdash" fill="none"/>`,
      );
      x += w + 8;
    });
    return out;
  };
  const c0 = cardX(0) + cw / 2;
  const c1 = cardX(1) + cw / 2;
  const c4 = cardX(4) + cw / 2;
  const v = arrive[4] as number;
  body.push(
    ...chips(["scout", "patterns", "rules"], c0 + 30, c0, 0.1, 1.6, "s", [C.teal, C.teal, C.teal]),
    ...chips(["logic", "contracts", "tests", "security"], c4, c4, v - 0.2, v + 1.4, "v", [
      C.green,
      C.red,
      C.green,
      C.green,
    ]),
    text(c0 + 30, 56, 11, C.muted, "parallel subagents", 'text-anchor="middle"'),
    text(c4, 56, 11, C.muted, "parallel lenses · one refuted", 'text-anchor="middle"'),
  );
  const loop = `M${c4},${rail} C${c4},${rail + 92} ${c1},${rail + 92} ${c1},${rail}`;
  body.push(
    `<path d="${loop}" stroke="${C.violet}" stroke-opacity=".55" stroke-width="1.5" fill="none" class="flowdash"/>`,
    text(
      (c1 + c4) / 2,
      rail + 92,
      12,
      C.violet,
      "blocking finding → back to plan (bounded loop)",
      'text-anchor="middle"',
    ),
    packet(loop, v + 0.3, v + 1.9, C.violet, dur, 5),
  );
  const header = `
  ${mono(32, 34, 12, C.gold, "THE METATOR LOOP", 'letter-spacing="2"')}
  ${mono(W - 32, 34, 12, C.muted, "state machine · artifacts · hard gates", 'text-anchor="end"')}`;
  const footer = text(
    W / 2,
    H - 22,
    13,
    C.muted,
    `LLMs decide <tspan fill="${C.gold}">·</tspan> Scripts measure <tspan fill="${C.gold}">·</tspan> Hooks enforce <tspan fill="${C.gold}">·</tspan> Humans approve`,
    'text-anchor="middle"',
  );
  return frame(
    W,
    H,
    "The Metator loop: survey, plan, gate, build, verify, ship",
    "The Metator loop",
    css,
    header + body.join("") + footer,
  );
}

// ─────────────────────────────────────────────────────────────────── review.svg
type Box = readonly [x: number, y: number, w: number, h: number];
const right = ([x, y, w, h]: Box): [number, number] => [x + w, y + h / 2];
const left = ([x, y, , h]: Box): [number, number] => [x, y + h / 2];
const curve = (p: [number, number], q: [number, number]) => {
  const mx = round((p[0] + q[0]) / 2, 1);
  return `M${round(p[0], 1)},${round(p[1], 1)} C${mx},${round(p[1], 1)} ${mx},${round(q[1], 1)} ${round(q[0], 1)},${round(q[1], 1)}`;
};

export function review(): string {
  const dur = 9;
  const W = 960;
  const H = 340;
  const css: string[] = [];
  const body: string[] = [];
  const block = ([x, y, w, h]: Box, title: string, sub: string[], accent: string, cls = "") => `
  <rect class="blk ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${C.panel}" stroke="${C.border}" stroke-width="1.5"/>
  ${text(x + 14, y + 26, 14, accent, title, 'font-weight="700"')}
  ${sub.map((s, i) => text(x + 14, y + 46 + i * 15, 11, C.muted, s)).join("")}`;

  const diff: Box = [30, 130, 120, 80];
  const shards: [Box, string][] = [
    [[190, 82, 116, 52], "shard · billing"],
    [[190, 206, 116, 52], "shard · orders"],
  ];
  const lensNames = ["logic", "contracts", "tests"];
  const lenses: [Box, string, number][] = [];
  shards.forEach(([[, sy, , sh]], s) => {
    lensNames.forEach((name, l) => {
      lenses.push([[350, sy + sh / 2 - 46 + l * 32, 104, 26], name, s]);
    });
  });
  const ver: Box = [520, 120, 150, 100];
  const judge: Box = [740, 120, 190, 100];
  const bin: Box = [520, 262, 150, 44];

  body.push(block(diff, "PR #42", ["diff · 14 files", "2 packages"], C.text));
  for (const [[x, y, w, h], label] of shards) {
    body.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.panel}" stroke="${C.border}"/>`,
      mono(x + w / 2, y + h / 2 + 4, 11, C.text, label, 'text-anchor="middle"'),
    );
  }
  lenses.forEach(([[x, y, w, h], label], i) => {
    const name = `lz${i}`;
    css.push(
      windowKeyframes(
        name,
        1.2 + (i % 3) * 0.1,
        2.6,
        dur,
        `stroke: ${C.teal}; fill: ${C.teal}22`,
        `stroke: ${C.border}; fill: ${C.panel}`,
      ),
      `.${name} { animation: ${name} ${dur}s linear infinite; }`,
    );
    body.push(
      `<rect class="${name}" x="${x}" y="${y}" width="${w}" height="${h}" rx="13"/>`,
      mono(x + w / 2, y + 17, 11, C.text, label, 'text-anchor="middle"'),
    );
  });
  body.push(
    block(ver, "VERIFY", ["independent model", "tries to refute", "every finding"], C.gold, "vb"),
    block(judge, "JUDGE", ["dedupe · calibrate", "verified-correct list"], C.teal, "jb"),
    `<rect class="rb" x="${bin[0]}" y="${bin[1]}" width="${bin[2]}" height="${bin[3]}" rx="10" fill="${C.panel}" stroke="${C.border}"/>`,
    mono(bin[0] + bin[2] / 2, bin[1] + 27, 12, C.red, "refuted ✕ 3", 'text-anchor="middle"'),
  );
  css.push(
    windowKeyframes("vlit", 2.6, 4.4, dur, `stroke: ${C.gold}`, `stroke: ${C.border}`),
    `.vb { animation: vlit ${dur}s linear infinite; }`,
    windowKeyframes("jlit", 4.6, dur - 0.6, dur, `stroke: ${C.teal}`, `stroke: ${C.border}`),
    `.jb { animation: jlit ${dur}s linear infinite; }`,
    windowKeyframes("rlit", 4.0, dur - 0.6, dur, `stroke: ${C.red}`, `stroke: ${C.border}`),
    `.rb { animation: rlit ${dur}s linear infinite; }`,
  );

  const paths: [string, number, number, string][] = [];
  for (const [s] of shards) paths.push([curve(right(diff), left(s)), 0.2, 0.9, C.text]);
  for (const [[x, y, , h], , s] of lenses) {
    paths.push([curve(right((shards[s] as [Box, string])[0]), [x, y + h / 2]), 0.9, 1.4, C.teal]);
  }
  [0, 1, 3, 4, 5].forEach((li, i) => {
    const [[x, y, w, h]] = lenses[li] as [Box, string, number];
    paths.push([
      curve([x + w, y + h / 2], [ver[0], ver[1] + 22 + i * 14]),
      2.0 + i * 0.08,
      2.9 + i * 0.08,
      C.gold,
    ]);
  });
  for (let i = 0; i < 2; i++) {
    paths.push([
      curve([ver[0] + ver[2], ver[1] + 40 + i * 20], [judge[0], judge[1] + 40 + i * 20]),
      3.9 + i * 0.15,
      4.6 + i * 0.15,
      C.green,
    ]);
  }
  for (let i = 0; i < 3; i++) {
    paths.push([
      `M${ver[0] + 30 + i * 45},${ver[1] + ver[3]} L${bin[0] + 30 + i * 45},${bin[1]}`,
      3.6 + i * 0.12,
      4.1 + i * 0.12,
      C.red,
    ]);
  }
  const wires = paths.map(([d]) => `<path d="${d}" stroke="${C.border}" stroke-width="1.2" fill="none"/>`);
  const dots = paths.map(([d, t0, t1, col]) => packet(d, t0, t1, col, dur, 4.5));

  const bx = judge[0];
  const by = judge[1] + judge[3] + 18;
  css.push(
    windowKeyframes(
      "verdict",
      4.9,
      dur - 0.6,
      dur,
      "opacity: 1; transform: translateY(0)",
      "opacity: 0; transform: translateY(6px)",
    ),
    `.verdict { animation: verdict ${dur}s ease-out infinite; }`,
  );
  const verdict = `
  <g class="verdict" opacity="0">
    <rect x="${bx}" y="${by}" width="${judge[2]}" height="46" rx="10" fill="${C.green}" fill-opacity=".12" stroke="${C.green}"/>
    ${text(bx + judge[2] / 2, by + 20, 13, C.green, "CHANGES REQUIRED", 'text-anchor="middle" font-weight="700"')}
    ${mono(bx + judge[2] / 2, by + 36, 10.5, C.text, "2 confirmed · with proof", 'text-anchor="middle"')}
  </g>`;
  const header = `
  ${mono(32, 36, 12, C.gold, "REVIEW WITH PROOF", 'letter-spacing="2"')}
  ${mono(W - 32, 36, 12, C.muted, "shard → find (parallel) → verify (refute) → judge", 'text-anchor="end"')}`;
  return frame(
    W,
    H,
    "Review pipeline: shard, find in parallel, verify by refutation, judge",
    "Find → Verify → Judge",
    css,
    header + wires.join("") + body.join("") + dots.join("") + verdict,
  );
}

// ─────────────────────────────────────────────────────────── architecture.svg
export function architecture(): string {
  const dur = 8;
  const W = 960;
  const H = 420;
  const css: string[] = [
    ".flowin { stroke-dasharray: 4 6; animation: flowin 1.2s linear infinite; }",
    "@keyframes flowin { to { stroke-dashoffset: -20; } }",
  ];
  // Nested layers, outermost first. Lighting runs outside → in: "dependencies point inward".
  const layers: [Box, string, string, string][] = [
    [[232, 74, 496, 292], "RUNTIME", "composition root · DI · config", C.muted],
    [[262, 112, 436, 236], "APPLICATION", "use cases · Result · constructor injection", C.teal],
    [[302, 150, 356, 180], "PORTS", "small interfaces (ISP)", C.violet],
    [[352, 196, 256, 108], "DOMAIN", "pure TS · zero I/O", C.gold],
  ];
  const body: string[] = [];
  layers.forEach(([[x, y, w, h], title, sub, accent], i) => {
    const name = `ly${i}`;
    css.push(
      windowKeyframes(
        name,
        0.3 + i * 0.7,
        0.3 + i * 0.7 + 1.0,
        dur,
        `stroke: ${accent}; stroke-opacity: 1`,
        `stroke: ${C.border}; stroke-opacity: 1`,
      ),
      `.${name} { animation: ${name} ${dur}s linear infinite; }`,
    );
    const dashed = i === 0 ? 'stroke-dasharray="6 5"' : "";
    const fill = i === 3 ? `${C.gold}14` : C.panel;
    body.push(
      `<rect class="${name}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${16 - i * 2}" fill="${fill}" stroke="${C.border}" stroke-width="1.5" ${dashed}/>`,
      mono(x + 14, y + 22, 11, accent, title, 'letter-spacing="1.5"'),
      text(x + w - 14, y + 22, 11, C.muted, sub, 'text-anchor="end"'),
    );
  });
  body.push(
    text(480, 258, 12, C.text, "Result · DependencyGraph · Diagnostic", 'text-anchor="middle"'),
    text(480, 280, 11, C.muted, "no node:*, no bun, no adapters", 'text-anchor="middle"'),
  );

  // Driving adapters (left) → application
  const driving = ["CLI", "Hooks", "MCP (soon)"];
  body.push(mono(40, 108, 11, C.gold, "DRIVING", 'letter-spacing="1.5"'));
  driving.forEach((label, i) => {
    const y = 130 + i * 62;
    const box: Box = [40, y, 132, 34];
    const name = `dr${i}`;
    css.push(
      windowKeyframes(name, 0.2 + i * 0.25, 1.4 + i * 0.25, dur, `stroke: ${C.teal}`, `stroke: ${C.border}`),
      `.${name} { animation: ${name} ${dur}s linear infinite; }`,
    );
    const path = `M${box[0] + box[2]},${y + 17} C${215},${y + 17} ${235},${233} ${352},${250}`;
    body.push(
      `<path d="${path}" stroke="${C.border}" stroke-width="1.2" fill="none"/>`,
      `<rect class="${name}" x="${box[0]}" y="${y}" width="${box[2]}" height="${box[3]}" rx="10" fill="${C.panel}" stroke="${C.border}" stroke-width="1.5"/>`,
      mono(box[0] + box[2] / 2, y + 22, 12, C.text, label, 'text-anchor="middle"'),
      packet(path, 0.4 + i * 0.5, 2.2 + i * 0.5, C.teal, dur, 4.5),
    );
  });

  // Driven adapters (right) plug into ports
  const driven = ["biome", "tsc", "ast-grep", "bun test", "git", "github", "copilot", "claude"];
  body.push(mono(W - 40, 80, 11, C.violet, "PLUGINS · ADAPTERS", 'letter-spacing="1.5" text-anchor="end"'));
  driven.forEach((label, i) => {
    const y = 94 + i * 33;
    const box: Box = [W - 40 - 130, y, 130, 26];
    const target: [number, number] = [658, 170 + i * 20];
    const path = curve([box[0], y + 13], target);
    const name = `dn${i}`;
    css.push(
      windowKeyframes(name, 4.6 + i * 0.12, 6.2, dur, `stroke: ${C.violet}`, `stroke: ${C.border}`),
      `.${name} { animation: ${name} ${dur}s linear infinite; }`,
    );
    body.push(
      `<path d="${path}" stroke="${C.violet}" stroke-opacity=".45" stroke-width="1.2" fill="none" class="flowin"/>`,
      `<rect class="${name}" x="${box[0]}" y="${y}" width="${box[2]}" height="${box[3]}" rx="13" fill="${C.panel}" stroke="${C.border}"/>`,
      mono(box[0] + box[2] / 2, y + 17, 11, C.text, label, 'text-anchor="middle"'),
    );
  });
  body.push(text(W - 40 - 65, 372, 11, C.muted, "implement ports", 'text-anchor="middle"'));

  const header = `
  ${mono(32, 36, 12, C.gold, "UNDER THE HOOD", 'letter-spacing="2"')}
  ${mono(W - 32, 36, 12, C.muted, "clean architecture · ports &amp; adapters", 'text-anchor="end"')}`;
  const footer = text(
    W / 2,
    H - 22,
    13,
    C.muted,
    `Dependencies point inward <tspan fill="${C.gold}">·</tspan> enforced by ast-grep in CI`,
    'text-anchor="middle"',
  );
  return frame(
    W,
    H,
    "Architecture: domain inside ports inside application inside runtime; CLI and hooks drive it, plugins implement ports",
    "MetatorAI architecture",
    css,
    header + body.join("") + footer,
  );
}

export const ASSETS = { hero, flow, review, architecture } as const;

if (import.meta.main) {
  const outDir = process.argv[2] ?? join(import.meta.dir, "../../assets");
  await mkdir(outDir, { recursive: true });
  for (const [name, render] of Object.entries(ASSETS)) await Bun.write(join(outDir, `${name}.svg`), render());
  console.log(`wrote ${Object.keys(ASSETS).length} SVGs to ${outDir}`);
}
