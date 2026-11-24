"""Writes docs/readme/hero.svg, the README banner. Run: python3 docs/readme/make-hero.py"""
from pathlib import Path

W, H = 1200, 380
BLUE, ROSE = "#2F6BFF", "#F43F5E"
GRID = [  # B = the district that is short, R = the one that is over
    "BBBBRRRRR",
    "BBBBBRRRR",
    "BBBBRRRRR",
    "BBBRRRRRR",
    "BBBBRRRRR",
    "BBBBBRRRR",
]
# Blocks that move R -> B, in painting order: (row, col, people)
MOVES = [(3, 3, 3), (2, 4, 2), (3, 4, 1)]
CELL, GAP = 39, 5
PITCH = CELL + GAP
GX, GY = 730, 96  # grid origin
T = [18, 34, 50]  # % of the loop at which each block is painted
END = 92          # % at which the loop resets
LOOP = 11         # seconds
CHIP = 189        # width of a deviation chip; two fit above the grid

def shade(r, c):
    return 0.80 + ((r * 7 + c * 13) % 5) * 0.05

cells, movers = [], []
for r, row in enumerate(GRID):
    for c, ch in enumerate(row):
        x, y = GX + c * PITCH, GY + r * PITCH
        fill = BLUE if ch == "B" else ROSE
        cells.append(f'<rect x="{x}" y="{y}" width="{CELL}" height="{CELL}" rx="7" fill="{fill}" opacity="{shade(r, c):.2f}"/>')
for i, (r, c, _) in enumerate(MOVES):
    x, y = GX + c * PITCH, GY + r * PITCH
    cx, cy = x + CELL / 2, y + CELL / 2
    movers.append(
        f'<rect class="flip f{i}" x="{x}" y="{y}" width="{CELL}" height="{CELL}" rx="7" fill="{BLUE}"/>'
        f'<rect class="ring r{i}" x="{x - 2.5}" y="{y - 2.5}" width="{CELL + 5}" height="{CELL + 5}" rx="9" fill="none" stroke="#fff" stroke-width="3"/>'
        f'<circle cx="{cx}" cy="{cy}" r="11.5" fill="#fff"/>'
        f'<text x="{cx}" y="{cy + 5}" text-anchor="middle" class="num">{i + 1}</text>'
    )

left = sum(p for _, _, p in MOVES)
states = [left]
for _, _, p in MOVES:
    states.append(states[-1] - p)          # 6, 3, 1, 0
windows = [(0, T[0]), (T[0], T[1]), (T[1], T[2]), (T[2], END)]

def chip(x, y, color, name, sign):
    out = [f'<g transform="translate({x},{y})">',
           f'<rect class="chip" width="{CHIP}" height="44" rx="22"/>',
           f'<rect class="chip ok" width="{CHIP}" height="44" rx="22"/>',
           f'<rect x="16" y="14" width="16" height="16" rx="4" fill="{color}"/>',
           f'<text x="42" y="29" class="chipname">{name}</text>']
    for i, v in enumerate(states):
        label = "0 ✓" if v == 0 else f"{sign}{v}"
        cls = "zero" if v == 0 else ("under" if sign == "−" else "over")
        out.append(f'<text x="{CHIP - 18}" y="30" text-anchor="end" class="dev {cls} s{i}">{label}</text>')
    out.append("</g>")
    return "".join(out)

css = [f"""
  text {{ font-family: ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }}
  .mono, .dev, .num {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }}
  .word {{ font-size: 78px; font-weight: 750; fill: #fff; letter-spacing: -2.2px; }}
  .kick {{ font-size: 25px; font-weight: 500; fill: #9FB0CC; }}
  .sub {{ font-size: 18px; fill: #6F82A3; letter-spacing: 0.4px; }}
  .num {{ font-size: 15px; font-weight: 700; fill: #0B1220; }}
  .chip {{ fill: #162034; stroke: #2A3954; stroke-width: 1.5; }}
  .chip.ok {{ fill: #0F2E25; stroke: #1F8A63; opacity: 0; animation: s3 {LOOP}s linear infinite; }}
  .chipname {{ font-size: 17px; font-weight: 600; fill: #D7E0EF; }}
  .dev {{ font-size: 19px; font-weight: 700; opacity: 0; }}
  .under {{ fill: #7FB0FF; }} .over {{ fill: #FF8FA3; }} .zero {{ fill: #4ADE80; }}
  .flip {{ opacity: 0; }}
  .ring {{ opacity: 0.95; }}
"""]
for i, (a, b) in enumerate(windows):
    wrap = " 97%, 100% { opacity: 1 }" if i == 0 else ""
    start = "0%" if a == 0 else f"{a}%, {a + 2}%"
    if i == 0:
        css.append(f"@keyframes s0 {{ 0%, {b}% {{ opacity: 1 }} {b + 2}%, 96% {{ opacity: 0 }}{wrap} }}")
    else:
        css.append(f"@keyframes s{i} {{ 0%, {a}% {{ opacity: 0 }} {a + 2}%, {b}% {{ opacity: 1 }} {b + 2}%, 100% {{ opacity: 0 }} }}")
    css.append(f".s{i} {{ animation: s{i} {LOOP}s linear infinite; }}")
for i, t in enumerate(T):
    css.append(f"@keyframes f{i} {{ 0%, {t}% {{ opacity: 0 }} {t + 2}%, {END}% {{ opacity: 1 }} {END + 4}%, 100% {{ opacity: 0 }} }}")
    css.append(f".f{i} {{ animation: f{i} {LOOP}s linear infinite; }}")
    lo = max(t - 12, 0)
    css.append(f"@keyframes r{i} {{ 0%, {lo}% {{ opacity: .35 }} {max(t - 6, 1)}% {{ opacity: 1 }} {t}% {{ opacity: .95 }} {t + 3}%, {END}% {{ opacity: 0 }} {END + 5}%, 100% {{ opacity: .35 }} }}")
    css.append(f".r{i} {{ animation: r{i} {LOOP}s linear infinite; }}")
css.append("@media (prefers-reduced-motion: reduce) { * { animation: none !important; } .flip, .chip.ok, .dev.s3 { opacity: 1; } .ring { opacity: 0; } }")

gw = len(GRID[0]) * PITCH - GAP
people = "   ".join(f"{'①②③'[i]} {p} {'person' if p == 1 else 'people'}" for i, (_, _, p) in enumerate(MOVES))
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-label="Zero Deviation: three census blocks are painted from one district into its neighbor and both districts' deviations count down from 6 to 0.">
<style>{''.join(css)}</style>
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E1728"/><stop offset="1" stop-color="#0A1120"/></linearGradient>
  <radialGradient id="glow" cx="0.78" cy="0.5" r="0.55"><stop offset="0" stop-color="#2F6BFF" stop-opacity="0.16"/><stop offset="1" stop-color="#2F6BFF" stop-opacity="0"/></radialGradient>
</defs>
<rect width="{W}" height="{H}" rx="26" fill="url(#bg)"/>
<rect width="{W}" height="{H}" rx="26" fill="url(#glow)"/>
<rect x="1" y="1" width="{W - 2}" height="{H - 2}" rx="25" fill="none" stroke="#243149" stroke-width="2"/>

<g transform="translate(72,96)">
  <circle cx="30" cy="30" r="29" fill="#0B1220" stroke="#fff" stroke-width="3.5"/>
  <rect x="20" y="15" width="20" height="30" rx="10" fill="none" stroke="#fff" stroke-width="5.5"/>
  <line x1="37.5" y1="19" x2="22.5" y2="41" stroke="#fff" stroke-width="3.8" stroke-linecap="round"/>
</g>
<text x="70" y="232" class="word">Zero Deviation</text>
<text x="74" y="276" class="kick">Every district at exactly the target population.</text>
<text x="74" y="312" class="sub mono">for Dave's Redistricting · runs in your browser</text>

{chip(GX, 34, BLUE, "District 4", "−")}
{chip(GX + gw - CHIP, 34, ROSE, "District 7", "+")}
{''.join(cells)}
{''.join(movers)}
</svg>
"""
Path(__file__).with_name("hero.svg").write_text(svg, encoding="utf-8")
print("hero.svg", len(svg), "bytes; grid width", gw)
