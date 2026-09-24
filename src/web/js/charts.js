// Meridian ERP :: web/charts
// Inline SVG charts. No chart library: these are a few dozen lines each,
// they inherit the theme through CSS variables, and they print correctly.
import { h } from './dom.js';
import * as fmt from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
};

/** Pick a "nice" axis maximum so gridlines land on round numbers. */
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * Vertical bar chart.
 * data: [{ label, value, tip? }]
 */
export function barChart(data, { height = 168, format = (v) => fmt.moneyCompact(v), gridLines = 4 } = {}) {
  const W = 640, H = height, padL = 52, padR = 8, padT = 10, padB = 24;
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const bw = data.length ? Math.min(46, (innerW / data.length) * 0.68) : 10;
  const step = data.length ? innerW / data.length : innerW;

  const kids = [];
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + innerH - (innerH * i) / gridLines;
    kids.push(svgEl('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
    kids.push(svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' }, format((max * i) / gridLines)));
  }
  data.forEach((d, i) => {
    const bh = Math.max(0, (d.value / max) * innerH);
    const x = padL + step * i + (step - bw) / 2;
    const y = padT + innerH - bh;
    kids.push(svgEl('rect', { class: 'bar', x, y, width: bw, height: bh, rx: 2 },
      svgEl('title', {}, d.tip || `${d.label}: ${format(d.value)}`)));
    kids.push(svgEl('text', { x: padL + step * i + step / 2, y: H - 7, 'text-anchor': 'middle' }, d.label));
  });
  kids.push(svgEl('line', { class: 'axis', x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH }));

  return svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' }, kids);
}

/** Line chart with a soft area fill. data: [{label, value}] */
export function lineChart(data, { height = 168, format = (v) => fmt.moneyCompact(v), gridLines = 4 } = {}) {
  const W = 640, H = height, padL = 52, padR = 10, padT = 10, padB = 24;
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (data.length > 1 ? (innerW * i) / (data.length - 1) : innerW / 2);
  const y = (v) => padT + innerH - (v / max) * innerH;

  const kids = [];
  for (let i = 0; i <= gridLines; i++) {
    const gy = padT + innerH - (innerH * i) / gridLines;
    kids.push(svgEl('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: gy, y2: gy }));
    kids.push(svgEl('text', { x: padL - 6, y: gy + 3, 'text-anchor': 'end' }, format((max * i) / gridLines)));
  }
  if (data.length) {
    const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
    kids.push(svgEl('path', { class: 'area', d: `${line} L${x(data.length - 1)},${padT + innerH} L${x(0)},${padT + innerH} Z` }));
    kids.push(svgEl('path', { class: 'line', d: line }));
    data.forEach((d, i) => {
      kids.push(svgEl('circle', { class: 'dot', cx: x(i), cy: y(d.value), r: 2.6 },
        svgEl('title', {}, `${d.label}: ${format(d.value)}`)));
      if (data.length <= 14 || i % 2 === 0) {
        kids.push(svgEl('text', { x: x(i), y: H - 7, 'text-anchor': 'middle' }, d.label));
      }
    });
  }
  kids.push(svgEl('line', { class: 'axis', x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH }));
  return svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' }, kids);
}

/** Horizontal stacked bar — used for aging buckets and mix breakdowns. */
export function stackedBar(segments, { height = 22, format = (v) => fmt.money(v) } = {}) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
  const colours = ['var(--pos)', 'var(--accent)', 'var(--warn)', 'var(--chart-brown)', 'var(--neg)'];
  let x = 0;
  const W = 640;
  const kids = segments.map((s, i) => {
    const w = (Math.max(0, s.value) / total) * W;
    const r = svgEl('rect', { x, y: 0, width: Math.max(0, w - 1), height, fill: s.colour || colours[i % colours.length], rx: 2 },
      svgEl('title', {}, `${s.label}: ${format(s.value)}`));
    x += w;
    return r;
  });
  return svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', role: 'img' }, kids);
}

/** Legend row for a stacked bar. */
export const legend = (segments, format = (v) => fmt.money(v)) => {
  const colours = ['var(--pos)', 'var(--accent)', 'var(--warn)', 'var(--chart-brown)', 'var(--neg)'];
  return h('div.row-tight.wrap', { style: { gap: 'var(--s3)', marginTop: 'var(--s2)', fontSize: 'var(--t-sm)' } },
    ...segments.map((s, i) => h('span.row', { style: { gap: 'var(--s2)' } },
      h('span', { style: { width: 'var(--s2)', height: 'var(--s2)', borderRadius: 'var(--radius-sm)', background: s.colour || colours[i % colours.length], display: 'inline-block' } }),
      h('span.muted', s.label),
      h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, format(s.value)))));
};

/** Donut for categorical splits. data: [{label, value}] */
export function donut(data, { size = 150, thickness = 22, centre = null } = {}) {
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const colours = ['var(--accent)', 'var(--pos)', 'var(--warn)', 'var(--chart-purple)', 'var(--neg)', 'var(--chart-blue)'];
  const kids = [];
  if (total <= 0) {
    kids.push(svgEl('circle', { cx: c, cy: c, r, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': thickness }));
  } else {
    let offset = 0;
    const circumference = 2 * Math.PI * r;
    data.forEach((d, i) => {
      const frac = Math.max(0, d.value) / total;
      if (frac <= 0) return;
      kids.push(svgEl('circle', {
        cx: c, cy: c, r, fill: 'none', stroke: d.colour || colours[i % colours.length],
        'stroke-width': thickness, 'stroke-dasharray': `${frac * circumference} ${circumference}`,
        'stroke-dashoffset': -offset * circumference, transform: `rotate(-90 ${c} ${c})`,
      }, svgEl('title', {}, `${d.label}: ${Math.round(frac * 100)}%`)));
      offset += frac;
    });
  }
  if (centre) {
    kids.push(svgEl('text', { x: c, y: c - 2, 'text-anchor': 'middle', style: 'font-size:var(--t-lg);font-weight:650;fill:var(--text)' }, centre.value));
    kids.push(svgEl('text', { x: c, y: c + 13, 'text-anchor': 'middle', style: 'font-size:var(--t-xs);fill:var(--text-muted)' }, centre.label));
  }
  return svgEl('svg', { class: 'chart', viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' }, kids);
}

/** Tiny inline trend line for KPI tiles. */
export function sparkline(values, { width = 96, height = 26 } = {}) {
  if (!values?.length) return h('span');
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((v, i) => [
    (i / Math.max(1, values.length - 1)) * width,
    height - ((v - min) / range) * (height - 3) - 1.5,
  ]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return svgEl('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' },
    svgEl('path', { class: 'line', d, 'stroke-width': 1.5 }),
    svgEl('circle', { class: 'dot', cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 2 }));
}
