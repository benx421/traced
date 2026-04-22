const PALETTE = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
];

const _cache = {};

export function serviceColor(name) {
  if (_cache[name]) return _cache[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(31, h) + name.charCodeAt(i) | 0;
  return (_cache[name] = PALETTE[Math.abs(h) % PALETTE.length]);
}
