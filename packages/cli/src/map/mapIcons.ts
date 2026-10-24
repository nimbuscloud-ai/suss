/**
 * The map's icons, inline SVG so the page needs nothing from the network.
 * Each one means one thing everywhere it appears, and its colour comes
 * from the class the page gives it (writes are orange, a finding is
 * violet), never from the icon itself.
 */

const svg = (body: string): string =>
  `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  write: svg('<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>'),
  read: svg(
    '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  ),
  table: svg(
    '<ellipse cx="8" cy="3.8" rx="5" ry="1.8"/><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8"/><path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>',
  ),
  env: svg(
    '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.5-2 1.5M8.5 10H11"/>',
  ),
  clash: svg(
    '<circle cx="8" cy="8" r="6"/><path d="M5.2 6.6h5.6M5.2 9.4h5.6M9.8 4.6l-3.6 6.8"/>',
  ),
  guard: svg(
    '<path d="M8 1.8l5 2v3.8c0 3.1-2.1 5.6-5 6.6-2.9-1-5-3.5-5-6.6V3.8z"/>',
  ),
  partial: svg('<circle cx="8" cy="8" r="5.6" stroke-dasharray="2.2 2"/>'),
  check: svg(
    '<circle cx="8" cy="8" r="6"/><path d="M5.4 8.2l1.8 1.8 3.4-3.6"/>',
  ),
  route: svg('<path d="M2.5 8h9M8.5 4.5L12 8l-3.5 3.5"/>'),
  type: svg(
    '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 6h5M8 6v5"/>',
  ),
  chevron: svg('<path d="M6 4l4 4-4 4"/>'),
  filter: svg('<path d="M2.5 3.5h11L9.5 8.5V13l-3-1.5v-3z"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
};

export type IconName = keyof typeof ICONS;

/** The icon with extra classes on it, such as the one that colours it. */
export function icon(name: IconName, cls: string): string {
  return ICONS[name].replace('class="ic"', `class="ic ${cls}"`);
}
