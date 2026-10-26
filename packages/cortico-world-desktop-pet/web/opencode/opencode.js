/**
 * The opencode terminal's drawing (web/opencode/figure.js): the kit's body, a square screen and the
 * five guest states. Coordinates are the kit's: logo units, ground at y=256, facing right.
 */

const GUEST = new Set(['idle', 'boot', 'work', 'wait', 'done', 'oops']);

/** The pack's own words; the guest page uses `set({ guest })`, a pet's bot may use these. */
export const TERMINAL_WORDS = {
  boot: { motion: { seconds: 1.2 } },
  work: { motion: { seconds: 3.6 } },
  wait: { motion: { seconds: 2.4, face: 'thinking' } },
  done: { motion: { seconds: 1.6, face: 'happy' } },
  oops: { motion: { seconds: 1.6, face: 'sad' } },
};

export const TERMINAL_CSS = `
.op-shell{fill:#CFCECD;stroke:#656363;stroke-width:3}
.op-bezel{fill:#656363}
.op-screen{fill:#211E1E}
.op-ink{fill:#F4F3F1}
.op-cut{fill:#211E1E}
.op-led{fill:#656363}
.op-accent{fill:#7B93FF}
.op-wait{fill:#FFB86B}
.op-error{fill:#FF6B6B}
.op-sweat{fill:#9AD7FF}
.op-limb{fill:#CFCECD;stroke:#656363;stroke-width:2}
.op-wire{fill:none;stroke:#656363;stroke-width:9;stroke-linecap:round}
.op-plug{fill:#CFCECD;stroke:#656363;stroke-width:2}
.op-arm{fill:none;stroke:#656363;stroke-width:9;stroke-linecap:round}
.op-hand{fill:#CFCECD;stroke:#656363;stroke-width:2}
.op-keyboard{fill:#656363}
.op-key{fill:#7B93FF}
.op-stroke{fill:none;stroke:#F4F3F1;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
.op-check{fill:none;stroke:#7B93FF;stroke-width:9;stroke-linecap:round;stroke-linejoin:round}
.op-text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700}
html[data-theme="light"] .op-shell,
html[data-theme="light"] .op-limb,
html[data-theme="light"] .op-plug,
html[data-theme="light"] .op-hand{fill:#211E1E}
html[data-theme="light"] .op-screen{fill:#CFCECD}
html[data-theme="light"] .op-ink{fill:#211E1E}
html[data-theme="light"] .op-cut{fill:#CFCECD}
html[data-theme="light"] .op-accent,
html[data-theme="light"] .op-key{fill:#4562F5}
html[data-theme="light"] .op-wait{fill:#C97A1E}
html[data-theme="light"] .op-error{fill:#D64545}
html[data-theme="light"] .op-sweat{fill:#4A9ED6}
html[data-theme="light"] .op-stroke{stroke:#211E1E}
html[data-theme="light"] .op-check{stroke:#4562F5}
`;

const f = (n) => Math.round(n * 10) / 10;

function eye(blink, x, y, w, h) {
  const k = Math.max(0.08, 1 - Math.min(1, blink) * 0.92);
  const cy = y + h / 2;
  return `<g transform="translate(0 ${f(cy)}) scale(1 ${k.toFixed(3)}) translate(0 ${f(-cy)})">`
    + `<rect class="op-ink" x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/>`
    + `<rect class="op-cut" x="${x + 4}" y="${y + 4}" width="4" height="5" rx="1.5"/>`
    + '</g>';
}

function arm(d, x, y) {
  return `<path class="op-arm" d="${d}"/><rect class="op-hand" x="${x}" y="${y}" width="14" height="14" rx="5"/>`;
}

function spark(x, y, s, t) {
  const o = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(t * 6 + x));
  return `<path class="op-accent" d="M${f(x)} ${f(y - 7 * s)} L${f(x + 2.2 * s)} ${f(y - 2.2 * s)} L${f(x + 7 * s)} ${f(y)} L${f(x + 2.2 * s)} ${f(y + 2.2 * s)} L${f(x)} ${f(y + 7 * s)} L${f(x - 2.2 * s)} ${f(y + 2.2 * s)} L${f(x - 7 * s)} ${f(y)} L${f(x - 2.2 * s)} ${f(y - 2.2 * s)} Z" opacity="${o.toFixed(2)}"/>`;
}

function content(guest, t, blink, since) {
  if (guest === 'boot') {
    return `<path class="op-stroke" d="M104 138 L116 148 L104 158" stroke-width="5"/>`
      + `<rect class="op-accent" x="126" y="152" width="18" height="6" rx="3" opacity="${Math.floor(t * 4) % 2 ? 1 : 0.2}"/>`
      + '<rect class="op-accent" x="68" y="134" width="120" height="1.5" opacity=".35"/>';
  }
  if (guest === 'work') {
    const bars = [[78, 98, 62], [78, 108, 44], [78, 118, 70], [78, 128, 38]].map(([x, y, w], i) =>
      `<rect class="op-ink" x="${x}" y="${y}" width="${w}" height="4" rx="2" opacity="${(0.22 + 0.18 * (0.5 + 0.5 * Math.sin(t * 5 + i))).toFixed(3)}"/>`).join('');
    const cursor = Math.floor(t * 3) % 2 ? 1 : 0.12;
    return `${bars}<rect class="op-accent" x="122" y="126" width="10" height="10" rx="2" opacity="${cursor}"/>`
      + `${eye(blink, 92, 140, 16, 12)}${eye(blink, 148, 140, 16, 12)}`
      + '<rect class="op-accent" x="118" y="162" width="20" height="4" rx="2"/>';
  }
  if (guest === 'wait') {
    return `${eye(blink, 84, 108, 16, 22)}${eye(blink, 140, 108, 16, 22)}`
      + '<text class="op-text op-wait" x="128" y="176" text-anchor="middle" font-size="44">?</text>';
  }
  if (guest === 'done') {
    const k = Math.min(1, (performance.now() - since) / 800);
    const hop = Math.sin(k * Math.PI);
    return `<path class="op-stroke" d="M90 128 Q100 ${f(118 - 8 * hop)} 110 128"/>`
      + `<path class="op-stroke" d="M146 128 Q156 ${f(118 - 8 * hop)} 166 128"/>`
      + '<path class="op-check" d="M102 158 L122 176 L154 144"/>'
      + `${spark(84, 106, 0.9, t)}${spark(172, 112, 0.75, t)}${spark(164, 170, 0.6, t)}`;
  }
  if (guest === 'oops') {
    return '<path class="op-stroke" d="M90 118 L102 124 L90 130"/>'
      + '<path class="op-stroke" d="M166 118 L154 124 L166 130"/>'
      + '<rect class="op-error" x="124" y="140" width="8" height="26" rx="4"/>'
      + '<rect class="op-error" x="124" y="172" width="8" height="8" rx="4"/>'
      + '<path class="op-sweat" d="M170 116 C178 126 180 130 176 134 C172 138 166 134 168 128 Z"/>';
  }
  const cursor = Math.floor(t * 1.6) % 2 ? 1 : 0.12;
  return '<path class="op-stroke" d="M78 98 L86 104 L78 110" opacity=".3" stroke-width="3"/>'
    + `${eye(blink, 92, 116, 16, 22)}${eye(blink, 148, 116, 16, 22)}`
    + `<rect class="op-accent" x="118" y="150" width="20" height="12" rx="3" opacity="${cursor}"/>`;
}

function arms(guest, t) {
  if (guest === 'work') {
    const tap = Math.sin(t * 8) * 1.5;
    return `<g>${arm('M52 138 C64 150 78 168 92 182', 86, 178 + tap)}${arm('M204 138 C192 150 178 168 164 182', 156, 178 - tap)}</g>`;
  }
  if (guest === 'wait') {
    return `<g>${arm('M52 138 C40 144 36 154 36 164', 28, 160)}${arm('M204 138 C214 126 220 112 222 100', 216, 94)}</g>`;
  }
  if (guest === 'done') {
    return `<g>${arm('M52 138 C40 126 34 110 32 96', 24, 90)}${arm('M204 138 C216 126 222 110 224 96', 216, 90)}</g>`;
  }
  if (guest === 'oops') {
    return `<g>${arm('M52 140 C42 152 38 164 36 174', 28, 172)}${arm('M204 140 C214 152 218 164 220 174', 212, 172)}</g>`;
  }
  return `<g>${arm('M52 138 C40 144 36 154 36 164', 28, 160)}${arm('M204 138 C216 144 220 154 220 164', 214, 160)}</g>`;
}

function keyboard(t) {
  const keys = Array.from({ length: 6 }, (_, i) => {
    const down = Math.floor(t * 6 + i) % 2 ? 1.5 : 0;
    return `<rect class="op-key" x="${94 + i * 12}" y="${197 + down}" width="8" height="6" rx="2"/>`;
  }).join('');
  return `<g><rect class="op-keyboard" x="88" y="190" width="80" height="16" rx="6"/>${keys}</g>`;
}

function terminal(guest, frame, since) {
  const t = frame.t ?? 0;
  const blink = frame.blink ?? 0;
  const bob = Math.sin(t * 2.4) * 1.5;
  const tail = Math.sin(t * 1.7) * 3;
  const antenna = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.6));
  const done = guest === 'done' ? Math.sin(Math.min(1, (performance.now() - since) / 800) * Math.PI) : 0;
  const hop = -14 * done;
  const slump = guest === 'oops' ? 3 : 0;
  const flip = frame.facing === -1 ? 'translate(256 0) scale(-1 1)' : '';
  const tailGroup = `<g transform="rotate(${f(tail)} 56 180)"><path class="op-wire" d="M56 180 C36 184 30 196 20 196"/><rect class="op-plug" x="8" y="190" width="14" height="12" rx="4"/><rect class="op-key" x="12" y="194" width="6" height="4" rx="1.5"/></g>`;
  const legs = '<g><rect class="op-limb" x="98" y="198" width="16" height="48" rx="8"/><rect class="op-limb" x="88" y="242" width="36" height="14" rx="7"/><rect class="op-limb" x="142" y="198" width="16" height="48" rx="8"/><rect class="op-limb" x="134" y="242" width="36" height="14" rx="7"/></g>';
  const shell = '<rect class="op-shell" x="48" y="64" width="160" height="148" rx="28"/>';
  const bezel = '<rect class="op-bezel" x="58" y="74" width="140" height="128" rx="20"/>';
  const screen = '<rect class="op-screen" x="68" y="86" width="120" height="104" rx="13"/>';
  const leds = `<rect class="op-accent" x="76" y="79" width="5" height="5" rx="2" opacity="${antenna.toFixed(2)}"/><rect class="op-led" x="86" y="79" width="5" height="5" rx="2"/><rect class="op-led" x="96" y="79" width="5" height="5" rx="2"/>`;
  const antennaGroup = `<g><path class="op-wire" d="M128 68 L128 48" stroke-width="6"/><rect class="op-accent" x="121" y="34" width="14" height="14" rx="4" opacity="${antenna.toFixed(2)}"/><rect class="op-cut" x="125" y="38" width="6" height="6" rx="2" opacity=".55"/></g>`;
  return `<g class="op" data-guest="${guest}" transform="${flip}">${tailGroup}${legs}`
    + `<g transform="translate(0 ${f(bob + hop + slump)})">${antennaGroup}${shell}${bezel}${screen}${leds}`
    + `${content(guest, t, blink, since)}${guest === 'work' ? keyboard(t) : ''}${arms(guest, t)}</g>`
    + '</g>';
}

export function createTerminalFigure(state) {
  let last = state.guest;
  let since = performance.now();
  return {
    draw(petG, _face, frame) {
      const gesture = frame.gesture?.kind;
      const guest = gesture && GUEST.has(gesture) ? gesture : GUEST.has(state.guest) ? state.guest : 'idle';
      if (guest !== last) {
        last = guest;
        since = performance.now();
      }
      petG.innerHTML = terminal(guest, frame, since);
    },
    get anchors() { return { bubble: [128, 18] }; },
    get extent() { return [34, 28, 222, 256]; },
    hits: [[128, 150, 72]],
    colors: { z: '#7B93FF' },
  };
}
