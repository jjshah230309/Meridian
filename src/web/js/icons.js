// Meridian ERP :: web/icons
// One stroked icon set, drawn as inline SVG.
//
// Why hand-authored paths rather than a font or a sprite sheet: a font is a
// network request and a flash of missing glyphs, a sprite sheet is a build
// step, and the Unicode geometric shapes this application used before (▤ ◈ ▣)
// render at whatever weight and baseline each platform feels like. These are
// 24-unit paths on a 24-unit grid at a single stroke width, so every icon in
// the product has the same optical weight as every other one -- which is most
// of what makes an interface look drawn rather than assembled.
//
// `currentColor` throughout, so an icon inherits the colour of the thing it
// sits in and needs no theme handling of its own.

const P = {
  // ---- navigation and structure
  home: 'M3 10.5 12 3l9 7.5M5.5 9v11h13V9',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  menu: 'M4 6h16M4 12h16M4 18h16',
  'panel-left': 'M3.5 4.5h17v15h-17zM9.5 4.5v15',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  command: 'M6 9V7.5a1.5 1.5 0 1 1 3 0V9m0 0h6m-6 0v6m0-6H7.5a1.5 1.5 0 1 0 0 3H9m6-3v6m0-6h1.5a1.5 1.5 0 1 1 0 3H15m-6 0v1.5a1.5 1.5 0 1 1-3 0V15m3 0h6m0 0v1.5a1.5 1.5 0 1 0 3 0V15',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9M10.3 19a2 2 0 0 0 3.4 0',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.4A2.5 2.5 0 1 1 12 12.5V14M12 17.2h.01',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z M19.3 14.6a1.4 1.4 0 0 0 .3 1.5l.1.1a1.6 1.6 0 1 1-2.3 2.3l-.1-.1a1.4 1.4 0 0 0-2.4 1v.3a1.6 1.6 0 1 1-3.2 0v-.2a1.4 1.4 0 0 0-2.4-1l-.1.1a1.6 1.6 0 1 1-2.3-2.3l.1-.1a1.4 1.4 0 0 0-1-2.4H5.6a1.6 1.6 0 1 1 0-3.2h.2a1.4 1.4 0 0 0 1-2.4l-.1-.1a1.6 1.6 0 1 1 2.3-2.3l.1.1a1.4 1.4 0 0 0 1.5.3h.1a1.4 1.4 0 0 0 .9-1.3V4.4a1.6 1.6 0 1 1 3.2 0v.2a1.4 1.4 0 0 0 2.4 1l.1-.1a1.6 1.6 0 1 1 2.3 2.3l-.1.1a1.4 1.4 0 0 0 1 2.4h.2a1.6 1.6 0 1 1 0 3.2h-.2a1.4 1.4 0 0 0-1.3.9Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  'chevron-down': 'M6 9.5l6 6 6-6',
  'chevron-up': 'M6 14.5l6-6 6 6',
  'chevron-right': 'M9.5 5.5l6 6.5-6 6.5',
  'chevron-left': 'M14.5 5.5l-6 6.5 6 6.5',
  'arrow-right': 'M4.5 12h14M13 6.5l5.5 5.5L13 17.5',
  'arrow-left': 'M19.5 12h-14M11 6.5 5.5 12 11 17.5',
  'arrow-up-right': 'M7 17 17 7M9 7h8v8',
  'arrow-down': 'M12 4.5v14M6.5 13l5.5 5.5L17.5 13',
  external: 'M14 4.5h5.5V10M19 5l-8 8M17 14v5.5H4.5V5H10',
  'more-horizontal': 'M6 12h.01M12 12h.01M18 12h.01',
  star: 'M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.9l5.8-.8Z',
  pin: 'M12 17v4M8 4h8l-1 6 3 3H6l3-3-1-6Z',
  filter: 'M4 5.5h16l-6 7v6l-4 2v-8Z',
  eye: 'M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  'log-out': 'M9.5 4.5H5.5v15h4M15 8l4 4-4 4M9 12h10',
  user: 'M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5ZM4.5 20c0-3.3 3.4-5.5 7.5-5.5s7.5 2.2 7.5 5.5',
  users: 'M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.1 3.1-5.2 7-5.2s7 2.1 7 5.2M16.5 4.6a3.5 3.5 0 0 1 0 6.8M18 14.9c2.1.6 3.5 2.1 3.5 4.1',
  lock: 'M6.5 10.5h11v9h-11zM9 10.5V8a3 3 0 0 1 6 0v2.5',
  shield: 'M12 3.5 19.5 6v5.5c0 4.4-3 7.4-7.5 9-4.5-1.6-7.5-4.6-7.5-9V6Z',

  // ---- money and accounting
  'book-open': 'M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2ZM12 6.5v13',
  'ledger': 'M5 4.5h14v15H5zM9 4.5v15M12.5 9h3.5M12.5 13h3.5',
  bank: 'M3.5 9.5 12 4.5l8.5 5M5.5 9.5v8M18.5 9.5v8M9.5 11.5v6M14.5 11.5v6M3.5 19.5h17',
  wallet: 'M3.5 7.5h17v12h-17zM3.5 7.5 6 4.5h12l2.5 3M16 13.5h2',
  'credit-card': 'M3 6.5h18v11H3zM3 10.5h18M6.5 14.5h3',
  coins: 'M9 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.8 13.7a5.5 5.5 0 1 1-6.4 6.5',
  receipt: 'M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8ZM9 8h6M9 12h6',
  'file-text': 'M14 3.5H6.5v17h11V7ZM14 3.5V7h3.5M9 12h6M9 15.5h4',
  invoice: 'M14 3.5H6.5v17h11V7ZM14 3.5V7h3.5M9 11h6M9 14.5h6M9 18h3',
  calculator: 'M5.5 3.5h13v17h-13zM8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01',
  percent: 'M19 5 5 19M7.5 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM16.5 19a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  scale: 'M12 4v16M7 8h10M4 15l3-7 3 7a3.5 3.5 0 0 1-6 0ZM14 15l3-7 3 7a3.5 3.5 0 0 1-6 0ZM8 20h8',
  'trending-up': 'M3.5 16.5 9 11l3.5 3.5L20 7M15 7h5v5',
  'trending-down': 'M3.5 7.5 9 13l3.5-3.5L20 17M15 17h5v-5',
  'bar-chart': 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  'pie-chart': 'M20.5 12A8.5 8.5 0 1 1 12 3.5V12Z M12 3.5A8.5 8.5 0 0 1 20.5 12H12Z',
  activity: 'M3 12.5h4l2.5-6 4 12 2.5-6h5',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  calendar: 'M4.5 6.5h15v14h-15zM4.5 11h15M8.5 3.5v4M15.5 3.5v4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3.5 2',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5',
  repeat: 'M17 3.5 20.5 7 17 10.5M20.5 7H7A3.5 3.5 0 0 0 3.5 10.5v1M7 20.5 3.5 17 7 13.5M3.5 17H17a3.5 3.5 0 0 0 3.5-3.5v-1',
  'exchange': 'M4 8.5h13M13.5 5 17 8.5 13.5 12M20 15.5H7M10.5 12 7 15.5 10.5 19',
  split: 'M12 4v6M12 10c0 3-3 4-5.5 4.5M12 10c0 3 3 4 5.5 4.5M4 14.5h5l-2.5-3M20 14.5h-5l2.5-3M12 4 9.5 6.5M12 4l2.5 2.5',
  layers: 'M12 3.5 3.5 8 12 12.5 20.5 8ZM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5',

  // ---- operations
  box: 'M20.5 8 12 3.5 3.5 8v8L12 20.5 20.5 16ZM3.5 8 12 12.5 20.5 8M12 12.5v8M7.75 5.75l8.5 4.5',
  package: 'M3.5 7.5 12 3.5l8.5 4v9L12 20.5 3.5 16.5ZM3.5 7.5 12 11.5l8.5-4M12 11.5v9',
  truck: 'M2.5 6.5h11v9h-11zM13.5 10h4l3 3v2.5h-7M6 19a1.75 1.75 0 1 0 0-3.5A1.75 1.75 0 0 0 6 19ZM17 19a1.75 1.75 0 1 0 0-3.5A1.75 1.75 0 0 0 17 19Z',
  factory: 'M3.5 20.5v-10l5 3v-3l5 3V6.5l7 4v10ZM8 16.5h.01M12 16.5h.01M16 16.5h.01',
  wrench: 'M15.5 3.5a5 5 0 0 0-4.3 7.5L4 18.2 5.8 20l7.2-7.2a5 5 0 0 0 6.5-6.3l-3 3-2.5-2.5Z',
  clipboard: 'M9 4.5H6.5v16h11v-16H15M9 3h6v3H9ZM9.5 11h5M9.5 15h5',
  'shopping-cart': 'M3 4.5h2.5l2.5 10h9l2.5-7H6M9 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM17 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  tag: 'M11 3.5H4.5V10l9.5 9.5 6.5-6.5ZM8 8h.01',
  building: 'M5 20.5v-16h9v16M14 9.5h5v11M8 8h3M8 11.5h3M8 15h3M17 13h.01M17 16.5h.01M3.5 20.5h17',
  briefcase: 'M3.5 8.5h17v11h-17zM8.5 8.5V6a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 6v2.5M3.5 13h17',
  'user-check': 'M10 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5ZM3 20c0-3.3 3.1-5.5 7-5.5M15.5 17.5l2 2 3.5-4',
  map: 'M12 21s6.5-5.6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21ZM12 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  'life-buoy': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9',

  // ---- data and platform
  database: 'M12 8.5c4.7 0 8.5-1.1 8.5-2.5S16.7 3.5 12 3.5 3.5 4.6 3.5 6 7.3 8.5 12 8.5ZM3.5 6v12c0 1.4 3.8 2.5 8.5 2.5s8.5-1.1 8.5-2.5V6M3.5 12c0 1.4 3.8 2.5 8.5 2.5s8.5-1.1 8.5-2.5',
  'arrows-up-down': 'M7.5 4v16M4 7.5 7.5 4 11 7.5M16.5 20V4M13 16.5l3.5 3.5 3.5-3.5',
  code: 'M9 7.5 4.5 12 9 16.5M15 7.5 19.5 12 15 16.5',
  puzzle: 'M10 4.5a1.75 1.75 0 0 1 3.5 0V6h3v3.5h1.5a1.75 1.75 0 0 1 0 3.5H16.5v6.5H13v-1.5a1.75 1.75 0 0 0-3.5 0V19.5H6V13H4.5a1.75 1.75 0 0 1 0-3.5H6V6h4Z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  table: 'M3.5 4.5h17v15h-17zM3.5 9.5h17M3.5 14.5h17M9.5 9.5v10',
  inbox: 'M3.5 12.5 6.5 4.5h11l3 8v7h-17ZM3.5 12.5h4l1 2.5h7l1-2.5h4',

  // ---- teaching
  'graduation-cap': 'M12 3.5 2.5 8 12 12.5 21.5 8ZM6 10v5.5c0 1.7 2.7 3 6 3s6-1.3 6-3V10M21.5 8v6',
  lightbulb: 'M9 17.5h6M10 20.5h4M12 3.5a5.5 5.5 0 0 1 3.2 10c-.5.4-.7.9-.7 1.5H9.5c0-.6-.2-1.1-.7-1.5A5.5 5.5 0 0 1 12 3.5Z',
  play: 'M7.5 4.5 19 12 7.5 19.5Z',
  route: 'M6.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM17.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6.5 8.5V13a3 3 0 0 0 3 3h5a3 3 0 0 1 3 2',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM15.5 8.5l-2 5-5 2 2-5Z',
  sparkles: 'M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8ZM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z',
  flag: 'M5.5 20.5V4.5h13l-2.5 4 2.5 4h-13',
  bookmark: 'M6.5 3.5h11v17L12 16.5 6.5 20.5Z',
  printer: 'M6.5 9V3.5h11V9M6.5 17.5H4.5v-8h15v8h-2M6.5 14h11v6.5h-11Z',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  download: 'M12 3.5v11M7.5 10 12 14.5 16.5 10M4.5 18.5h15',
  upload: 'M12 20.5v-11M7.5 14 12 9.5 16.5 14M4.5 5.5h15',
};

const VIEWBOX = '0 0 24 24';

/**
 * An icon element. `name` falls back to a dot, so a missing name is a small
 * blemish rather than a hole in the layout or a thrown error.
 */
export function icon(name, { size = 16, className = '', title = null, strokeWidth = 1.7 } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', VIEWBOX);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', title ? 'false' : 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ic');
  if (className) String(className).split(/\s+/).filter(Boolean).forEach((c) => svg.classList.add(c));
  if (title) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = title;
    svg.appendChild(t);
    svg.setAttribute('role', 'img');
  }
  const d = P[name] || 'M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z';
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}

/** Filled variant, for the one or two places a solid mark reads better. */
export function iconFilled(name, opts = {}) {
  const svg = icon(name, opts);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('stroke', 'none');
  return svg;
}

export const hasIcon = (name) => Object.hasOwn(P, name);
export const iconNames = () => Object.keys(P);
