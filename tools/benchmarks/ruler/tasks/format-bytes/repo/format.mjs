// 把字节数写成人看的大小。
export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}
