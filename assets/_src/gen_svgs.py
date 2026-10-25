"""Generates animated SVGs for the MetatorAI README (CSS + SMIL, no JS)."""
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
C = dict(bg="#0d1117", panel="#161b22", lit="#1f2630", border="#30363d", text="#e6edf3",
         muted="#8b949e", gold="#f0b429", teal="#2dd4bf", violet="#a78bfa", red="#f87171", green="#4ade80")

DEFS = f"""
  <defs>
    <filter id="glow" x="-200%" y="-200%" width="500%" height="500%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{C['bg']}"/><stop offset="1" stop-color="#111827"/>
    </linearGradient>
  </defs>"""


def pct(t, dur):
    return round(100 * t / dur, 3)


def kt(t, dur):
    return round(max(0.0, min(1.0, t / dur)), 4)


def packet(path, t0, t1, color, dur, r=5, fade=0.15):
    """Dot that is invisible until t0, travels the path t0→t1, fades out after t1."""
    a, b = kt(t0, dur), kt(t1, dur)
    a0, b1 = kt(max(t0 - 0.05, 0.01), dur), kt(min(t1 + fade, dur - 0.01), dur)
    if a0 >= a:
        a0 = round(a - 0.001, 4)
    return f"""
    <circle r="{r}" fill="{color}" filter="url(#glow)" opacity="0">
      <animateMotion dur="{dur}s" repeatCount="indefinite" calcMode="linear"
        keyPoints="0;0;1;1" keyTimes="0;{a};{b};1" path="{path}"/>
      <animate attributeName="opacity" dur="{dur}s" repeatCount="indefinite"
        values="0;0;1;1;0;0" keyTimes="0;{a0};{a};{b};{b1};1"/>
    </circle>"""


def window_keyframes(name, t_on, t_off, dur, on, off):
    """CSS keyframes that hold `on` styles between t_on and t_off within the loop."""
    p_on, p_off = pct(t_on, dur), pct(t_off, dur)
    p_on0 = max(p_on - 1.5, 0)
    p_off1 = min(p_off + 3, 100)
    return (f"@keyframes {name} {{ 0%, {p_on0}% {{ {off} }} {p_on}%, {p_off}% {{ {on} }} "
            f"{p_off1}%, 100% {{ {off} }} }}")


# ─────────────────────────────────────────────────────────────── hero.svg
def hero():
    dur = 9
    W, H = 960, 260
    gx, gy, gs, n = 40, 30, 200, 6          # survey grid
    step = gs / n
    lines, css = [], []
    for i in range(n + 1):
        d = round(i * step, 2)
        lines.append(f'<line class="gl v{i}" x1="{gx + d}" y1="{gy}" x2="{gx + d}" y2="{gy + gs}"/>')
        lines.append(f'<line class="gl h{i}" x1="{gx}" y1="{gy + d}" x2="{gx + gs}" y2="{gy + d}"/>')
        t0 = 0.2 + i * 0.18
        css.append(window_keyframes(f"draw{i}", t0 + 0.9, dur - 0.8, dur,
                                    "stroke-dashoffset: 0; opacity: 1", f"stroke-dashoffset: {gs}; opacity: .9"))
        css.append(f".v{i}, .h{i} {{ animation: draw{i} {dur}s ease-in-out infinite; }}")
    # camp "units" that appear in cells: agents taking their place
    cells = [(1, 1, C['gold']), (3, 1, C['teal']), (4, 3, C['violet']), (1, 4, C['teal']),
             (5, 1, C['gold']), (4, 4, C['gold']), (5, 5, C['green']), (0, 2, C['violet'])]
    units = []
    for k, (cx, cy, col) in enumerate(cells):
        x = gx + cx * step + 6
        y = gy + cy * step + 6
        units.append(f'<rect class="u{k}" x="{x:.1f}" y="{y:.1f}" width="{step - 12:.1f}" height="{step - 12:.1f}" rx="4" fill="{col}" fill-opacity=".85"/>')
        t_on = 2.6 + k * 0.32
        css.append(window_keyframes(f"unit{k}", t_on, dur - 0.9, dur,
                                    "opacity: 1; transform: scale(1)", "opacity: 0; transform: scale(.4)"))
        css.append(f".u{k} {{ transform-box: fill-box; transform-origin: center; animation: unit{k} {dur}s ease-out infinite; }}")

    # groma cross at grid centre
    cx, cy = gx + gs / 2, gy + gs / 2
    groma = f"""
    <g class="groma" stroke="{C['text']}" stroke-width="2" fill="none" opacity=".9">
      <line x1="{cx - 26}" y1="{cy}" x2="{cx + 26}" y2="{cy}"/>
      <line x1="{cx}" y1="{cy - 26}" x2="{cx}" y2="{cy + 26}"/>
      <circle cx="{cx}" cy="{cy}" r="3.5" fill="{C['gold']}" stroke="none"/>
      {''.join(f'<line x1="{x}" y1="{y}" x2="{x}" y2="{y + 9}" stroke-width="1"/><circle cx="{x}" cy="{y + 11}" r="2.2" fill="{C["text"]}" stroke="none"/>'
               for x, y in [(cx - 26, cy), (cx + 26, cy), (cx, cy - 26), (cx, cy + 26)])}
    </g>"""
    css.append(f"@keyframes spin {{ from {{ transform: rotate(0deg); }} to {{ transform: rotate(90deg); }} }}")
    css.append(f".groma {{ transform-origin: {cx}px {cy}px; animation: spin {dur}s cubic-bezier(.7,0,.3,1) infinite; }}")

    tx = 300
    type_w = 408
    tagline = "Lay out the ground. Then build."
    css.append("@keyframes blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }")
    css.append(".cursor { animation: blink 1s steps(1) infinite; }")
    css.append(f".gl {{ stroke: {C['border']}; stroke-width: 1.2; stroke-dasharray: {gs}; stroke-dashoffset: {gs}; }}")

    a, b, c = kt(0.6, dur), kt(3.0, dur), kt(dur - 0.6, dur)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="MetatorAI: Lay out the ground. Then build.">
  <title>MetatorAI: Lay out the ground. Then build.</title>{DEFS}
    <linearGradient id="titleGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="{C['gold']}"/>
      <stop offset=".5" stop-color="#fde68a"/>
      <stop offset="1" stop-color="{C['teal']}"/>
      <animateTransform attributeName="gradientTransform" type="translate" values="-0.6 0;0.6 0;-0.6 0" dur="{dur}s" repeatCount="indefinite"/>
    </linearGradient>
    <clipPath id="typeClip">
      <rect x="{tx}" y="128" height="40" width="0">
        <animate attributeName="width" dur="{dur}s" repeatCount="indefinite" values="0;0;{type_w};{type_w};0" keyTimes="0;{a};{b};{c};1"/>
      </rect>
    </clipPath>
  <style>{' '.join(css)}</style>
  <rect width="{W}" height="{H}" rx="18" fill="url(#bgGrad)" stroke="{C['border']}"/>
  <g>{''.join(lines)}</g>
  <g>{''.join(units)}</g>
  {groma}
  <text x="{tx}" y="104" font-family="{SANS}" font-size="68" font-weight="800" letter-spacing="-1.5" fill="url(#titleGrad)">MetatorAI</text>
  <text x="{tx}" y="158" font-family="{SANS}" font-size="27" font-weight="600" fill="{C['text']}" clip-path="url(#typeClip)">{tagline}</text>
  <rect class="cursor" x="{tx}" y="134" width="3" height="30" fill="{C['gold']}">
    <animate attributeName="x" dur="{dur}s" repeatCount="indefinite" values="{tx};{tx};{tx + type_w + 4};{tx + type_w + 4};{tx}" keyTimes="0;{a};{b};{c};1"/>
  </rect>
  <text x="{tx}" y="200" font-family="{SANS}" font-size="16" fill="{C['muted']}">Agentic engineering for GitHub Copilot &amp; Claude Code: survey first, prove everything.</text>
  <text x="{tx}" y="228" font-family="{MONO}" font-size="12" fill="{C['muted']}" opacity=".8">survey · plan · gate · build · verify · ship</text>
</svg>"""
    (OUT / "hero.svg").write_text(svg)


# ─────────────────────────────────────────────────────────────── flow.svg
def flow():
    dur = 10
    W, H = 960, 420
    cards = [
        ("01", "SURVEY", ["graph · patterns", "rules from ADRs"]),
        ("02", "PLAN", ["every step cites", "a real exemplar"]),
        ("03", "GATE", ["plan lint + critic", "+ your approval"]),
        ("04", "BUILD", ["tests RED → GREEN", "inside plan scope"]),
        ("05", "VERIFY", ["find → refute", "→ judge"]),
        ("06", "SHIP", ["PR only after", "a human says go"]),
    ]
    cw, ch, cy0, gap, x0 = 128, 96, 120, 26, 32
    rail = 252
    travel = 8.0
    arrive = [round(travel * k / 5, 3) for k in range(6)]
    css, body = [], []

    css.append(f".card {{ fill: {C['panel']}; stroke: {C['border']}; stroke-width: 1.5; }}")
    css.append(f".chip {{ fill: {C['panel']}; stroke: {C['border']}; }}")
    css.append(f".flowdash {{ stroke-dasharray: 4 6; animation: dash 1.2s linear infinite; }}")
    css.append("@keyframes dash { to { stroke-dashoffset: -20; } }")

    for k, (num, title, sub) in enumerate(cards):
        x = x0 + k * (cw + gap)
        cx = x + cw / 2
        t = arrive[k]
        css.append(window_keyframes(f"lit{k}", t, t + 1.1, dur,
                                    f"fill: {C['lit']}; stroke: {C['gold']}", f"fill: {C['panel']}; stroke: {C['border']}"))
        css.append(f".c{k} {{ animation: lit{k} {dur}s linear infinite; }}")
        css.append(window_keyframes(f"chk{k}", t + 0.15, dur - 0.5, dur, "opacity: 1", "opacity: 0"))
        css.append(f".k{k} {{ animation: chk{k} {dur}s linear infinite; }}")
        css.append(window_keyframes(f"node{k}", t, t + 0.6, dur, f"fill: {C['gold']}; r: 7px", f"fill: {C['border']}; r: 5px"))
        css.append(f".n{k} {{ animation: node{k} {dur}s linear infinite; }}")
        body.append(f"""
  <rect class="card c{k}" x="{x}" y="{cy0}" width="{cw}" height="{ch}" rx="12"/>
  <text x="{x + 14}" y="{cy0 + 24}" font-family="{MONO}" font-size="11" fill="{C['gold']}">{num}</text>
  <text x="{x + 14}" y="{cy0 + 50}" font-family="{SANS}" font-size="16" font-weight="700" fill="{C['text']}" letter-spacing=".5">{title}</text>
  <text x="{x + 14}" y="{cy0 + 71}" font-family="{SANS}" font-size="11" fill="{C['muted']}">{sub[0]}</text>
  <text x="{x + 14}" y="{cy0 + 85}" font-family="{SANS}" font-size="11" fill="{C['muted']}">{sub[1]}</text>
  <g class="k{k}" opacity="0">
    <circle cx="{x + cw - 18}" cy="{cy0 + 20}" r="9" fill="{C['green']}" fill-opacity=".18" stroke="{C['green']}"/>
    <path d="M{x + cw - 22.5} {cy0 + 20} l3 3 l6 -6" stroke="{C['green']}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <line x1="{cx}" y1="{cy0 + ch}" x2="{cx}" y2="{rail}" stroke="{C['border']}" stroke-width="1.5"/>
  <circle class="n{k}" cx="{cx}" cy="{rail}" r="5" fill="{C['border']}"/>""")

    first_cx = x0 + cw / 2
    last_cx = x0 + 5 * (cw + gap) + cw / 2
    rail_path = f"M{first_cx},{rail} L{last_cx},{rail}"
    body.insert(0, f'<path d="{rail_path}" stroke="{C["border"]}" stroke-width="2" fill="none"/>')
    body.append(f'<path d="{rail_path}" stroke="{C["gold"]}" stroke-opacity=".35" stroke-width="2" fill="none" class="flowdash"/>')

    # main packet (+ trailing echoes)
    for lag, r, op in [(0.0, 7, 1), (0.12, 4.5, .55), (0.24, 3, .3)]:
        body.append(packet(f"M{first_cx},{rail} L{last_cx},{rail}", 0.06 + lag, travel + lag, C['gold'], dur, r=r)
                    .replace('opacity="0">', f'opacity="0" fill-opacity="{op}">', 1))

    # parallel chips: above SURVEY and VERIFY
    def chips(labels, center, card_cx, t_on, t_off, cls, colors):
        out, widths = [], [len(s) * 6.6 + 18 for s in labels]
        total = sum(widths) + 8 * (len(labels) - 1)
        x = center - total / 2
        for i, (lab, w) in enumerate(zip(labels, widths)):
            col = colors[i]
            name = f"{cls}{i}"
            css.append(window_keyframes(name, t_on + i * 0.12, t_off, dur,
                                        f"stroke: {col}; fill: {col}22", f"stroke: {C['border']}; fill: {C['panel']}"))
            css.append(f".{name} {{ animation: {name} {dur}s linear infinite; }}")
            out.append(f'<rect class="chip {name}" x="{x:.1f}" y="66" width="{w:.1f}" height="24" rx="12"/>')
            out.append(f'<text x="{x + w / 2:.1f}" y="82" text-anchor="middle" font-family="{MONO}" font-size="11" fill="{C["text"]}">{lab}</text>')
            mx = x + w / 2
            out.append(f'<path d="M{mx:.1f},90 C{mx:.1f},106 {card_cx:.1f},104 {card_cx:.1f},{cy0}" stroke="{C["border"]}" class="flowdash" fill="none"/>')
            x += w + 8
        return out

    c0 = x0 + cw / 2
    c4 = x0 + 4 * (cw + gap) + cw / 2
    body += chips(["scout", "patterns", "rules"], c0 + 30, c0, 0.1, 1.6, "s", [C['teal']] * 3)
    body += chips(["logic", "contracts", "tests", "security"], c4, c4, arrive[4] - 0.2, arrive[4] + 1.4, "v",
                  [C['green'], C['red'], C['green'], C['green']])
    body.append(f'<text x="{c0 + 30}" y="56" text-anchor="middle" font-family="{SANS}" font-size="11" fill="{C["muted"]}">parallel subagents</text>')
    body.append(f'<text x="{c4}" y="56" text-anchor="middle" font-family="{SANS}" font-size="11" fill="{C["muted"]}">parallel lenses · one refuted</text>')

    # feedback loop: VERIFY → PLAN
    c1 = x0 + (cw + gap) + cw / 2
    loop = f"M{c4},{rail} C{c4},{rail + 92} {c1},{rail + 92} {c1},{rail}"
    body.append(f'<path d="{loop}" stroke="{C["violet"]}" stroke-opacity=".55" stroke-width="1.5" fill="none" class="flowdash"/>')
    body.append(f'<text x="{(c1 + c4) / 2}" y="{rail + 92}" text-anchor="middle" font-family="{SANS}" font-size="12" fill="{C["violet"]}">blocking finding → back to plan (bounded loop)</text>')
    body.append(packet(loop, arrive[4] + 0.3, arrive[4] + 1.9, C['violet'], dur, r=5))

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="The Metator loop: survey, plan, gate, build, verify, ship">
  <title>The Metator loop</title>{DEFS}
  <style>{' '.join(css)}</style>
  <rect width="{W}" height="{H}" rx="18" fill="url(#bgGrad)" stroke="{C['border']}"/>
  <text x="32" y="34" font-family="{MONO}" font-size="12" fill="{C['gold']}" letter-spacing="2">THE METATOR LOOP</text>
  <text x="{W - 32}" y="34" text-anchor="end" font-family="{MONO}" font-size="12" fill="{C['muted']}">state machine · artifacts · hard gates</text>
  {''.join(body)}
  <text x="{W / 2}" y="{H - 22}" text-anchor="middle" font-family="{SANS}" font-size="13" fill="{C['muted']}">LLMs decide <tspan fill="{C['gold']}">·</tspan> Scripts measure <tspan fill="{C['gold']}">·</tspan> Hooks enforce <tspan fill="{C['gold']}">·</tspan> Humans approve</text>
</svg>"""
    (OUT / "flow.svg").write_text(svg)


# ─────────────────────────────────────────────────────────────── review.svg
def review():
    dur = 9
    W, H = 960, 340
    css, body = [], []

    def block(x, y, w, h, title, sub, accent, cls=""):
        return f"""
  <rect class="blk {cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{C['panel']}" stroke="{C['border']}" stroke-width="1.5"/>
  <text x="{x + 14}" y="{y + 26}" font-family="{SANS}" font-size="14" font-weight="700" fill="{accent}">{title}</text>
  {''.join(f'<text x="{x + 14}" y="{y + 46 + i * 15}" font-family="{SANS}" font-size="11" fill="{C["muted"]}">{s}</text>' for i, s in enumerate(sub))}"""

    # columns
    diff = (30, 130, 120, 80)
    shards = [(190, 82, 116, 52, "shard · billing"), (190, 206, 116, 52, "shard · orders")]
    lens_names = ["logic", "contracts", "tests"]
    lenses = []
    for s_i, (_, sy, _, sh, _) in enumerate(shards):
        for l_i, ln in enumerate(lens_names):
            ly = sy + sh / 2 - 46 + l_i * 32
            lenses.append((350, ly, 104, 26, ln, s_i))
    ver = (520, 120, 150, 100)
    judge = (740, 120, 190, 100)
    rbin = (520, 262, 150, 44)

    body.append(block(*diff, "PR #42", ["diff · 14 files", "2 packages"], C['text']))
    for (x, y, w, h, lab) in shards:
        body.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{C["panel"]}" stroke="{C["border"]}"/>')
        body.append(f'<text x="{x + w / 2}" y="{y + h / 2 + 4}" text-anchor="middle" font-family="{MONO}" font-size="11" fill="{C["text"]}">{lab}</text>')
    for i, (x, y, w, h, lab, _) in enumerate(lenses):
        name = f"lz{i}"
        css.append(window_keyframes(name, 1.2 + (i % 3) * 0.1, 2.6, dur,
                                    f"stroke: {C['teal']}; fill: {C['teal']}22", f"stroke: {C['border']}; fill: {C['panel']}"))
        css.append(f".{name} {{ animation: {name} {dur}s linear infinite; }}")
        body.append(f'<rect class="{name}" x="{x}" y="{y}" width="{w}" height="{h}" rx="13"/>')
        body.append(f'<text x="{x + w / 2}" y="{y + 17}" text-anchor="middle" font-family="{MONO}" font-size="11" fill="{C["text"]}">{lab}</text>')
    body.append(block(*ver, "VERIFY", ["independent model", "tries to refute", "every finding"], C['gold'], "vb"))
    body.append(block(*judge, "JUDGE", ["dedupe · calibrate", "verified-correct list"], C['teal'], "jb"))
    body.append(f'<rect class="rb" x="{rbin[0]}" y="{rbin[1]}" width="{rbin[2]}" height="{rbin[3]}" rx="10" fill="{C["panel"]}" stroke="{C["border"]}"/>')
    body.append(f'<text x="{rbin[0] + rbin[2] / 2}" y="{rbin[1] + 27}" text-anchor="middle" font-family="{MONO}" font-size="12" fill="{C["red"]}">refuted ✕ 3</text>')

    css.append(window_keyframes("vlit", 2.6, 4.4, dur, f"stroke: {C['gold']}", f"stroke: {C['border']}"))
    css.append(".vb { animation: vlit %ss linear infinite; }" % dur)
    css.append(window_keyframes("jlit", 4.6, dur - 0.6, dur, f"stroke: {C['teal']}", f"stroke: {C['border']}"))
    css.append(".jb { animation: jlit %ss linear infinite; }" % dur)
    css.append(window_keyframes("rlit", 4.0, dur - 0.6, dur, f"stroke: {C['red']}", f"stroke: {C['border']}"))
    css.append(".rb { animation: rlit %ss linear infinite; }" % dur)

    def right(b):
        return b[0] + b[2], b[1] + b[3] / 2

    def left(b):
        return b[0], b[1] + b[3] / 2

    def curve(p, q):
        mx = (p[0] + q[0]) / 2
        return f"M{p[0]:.1f},{p[1]:.1f} C{mx:.1f},{p[1]:.1f} {mx:.1f},{q[1]:.1f} {q[0]:.1f},{q[1]:.1f}"

    paths = []
    # diff → shards
    for s in shards:
        paths.append((curve(right(diff), left(s[:4])), 0.2, 0.9, C['text']))
    # shards → lenses
    for (x, y, w, h, _, s_i) in lenses:
        s = shards[s_i]
        paths.append((curve(right(s[:4]), (x, y + h / 2)), 0.9, 1.4, C['teal']))
    # findings: 5 lenses produce a finding → verify
    finders = [0, 1, 3, 4, 5]
    vtarget = [(ver[0], ver[1] + 22 + i * 14) for i in range(5)]
    for i, li in enumerate(finders):
        x, y, w, h, _, _ = lenses[li]
        paths.append((curve((x + w, y + h / 2), vtarget[i]), 2.0 + i * 0.08, 2.9 + i * 0.08, C['gold']))
    # verify → judge (2 confirmed) and → refuted bin (3)
    for i in range(2):
        paths.append((curve((ver[0] + ver[2], ver[1] + 40 + i * 20), (judge[0], judge[1] + 40 + i * 20)), 3.9 + i * 0.15, 4.6 + i * 0.15, C['green']))
    for i in range(3):
        p = (ver[0] + 30 + i * 45, ver[1] + ver[3])
        q = (rbin[0] + 30 + i * 45, rbin[1])
        paths.append((f"M{p[0]},{p[1]} L{q[0]},{q[1]}", 3.6 + i * 0.12, 4.1 + i * 0.12, C['red']))

    wires = []
    for d, t0, t1, col in paths:
        wires.append(f'<path d="{d}" stroke="{C["border"]}" stroke-width="1.2" fill="none"/>')
        body.append(packet(d, t0, t1, col, dur, r=4.5))
    body = wires + body

    # verdict badge
    bx, by = judge[0], judge[1] + judge[3] + 18
    css.append(window_keyframes("verdict", 4.9, dur - 0.6, dur, "opacity: 1; transform: translateY(0)", "opacity: 0; transform: translateY(6px)"))
    css.append(".verdict { animation: verdict %ss ease-out infinite; }" % dur)
    body.append(f"""
  <g class="verdict" opacity="0">
    <rect x="{bx}" y="{by}" width="{judge[2]}" height="46" rx="10" fill="{C['green']}" fill-opacity=".12" stroke="{C['green']}"/>
    <text x="{bx + judge[2] / 2}" y="{by + 20}" text-anchor="middle" font-family="{SANS}" font-size="13" font-weight="700" fill="{C['green']}">CHANGES REQUIRED</text>
    <text x="{bx + judge[2] / 2}" y="{by + 36}" text-anchor="middle" font-family="{MONO}" font-size="10.5" fill="{C['text']}">2 confirmed · with proof</text>
  </g>""")

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="Review pipeline: shard, find in parallel, verify by refutation, judge">
  <title>Find → Verify → Judge</title>{DEFS}
  <style>{' '.join(css)}</style>
  <rect width="{W}" height="{H}" rx="18" fill="url(#bgGrad)" stroke="{C['border']}"/>
  <text x="32" y="36" font-family="{MONO}" font-size="12" fill="{C['gold']}" letter-spacing="2">REVIEW WITH PROOF</text>
  <text x="{W - 32}" y="36" text-anchor="end" font-family="{MONO}" font-size="12" fill="{C['muted']}">shard → find (parallel) → verify (refute) → judge</text>
  {''.join(body)}
</svg>"""
    (OUT / "review.svg").write_text(svg)


hero()
flow()
review()
print("written to", OUT)
