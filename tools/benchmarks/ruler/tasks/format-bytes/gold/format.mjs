// 把字节数写成人看的大小。
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n) {
  const sign = n < 0 ? '-' : '';
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  const text = unit === 0 ? String(value) : String(Number(value.toFixed(1)));
  return `${sign}${text} ${UNITS[unit]}`;
}
