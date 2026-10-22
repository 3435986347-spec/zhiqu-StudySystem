// Server-Sent Events 的增量解析：喂任意切开的文本块，吐出完整的 {event, data}。
// 服务器（Spring SseEmitter）写的是 `event:name` / `data:{json}` / 空行，冒号后可能没有空格。
export class SseParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.event = 'message';
    this.data = [];
  }

  feed(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line);
    }
  }

  line(line) {
    if (line === '') {
      if (this.data.length) this.onEvent(this.event, this.data.join('\n'));
      this.event = 'message';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }

  end() {
    if (this.buffer) this.line(this.buffer);
    this.buffer = '';
    this.line('');
  }
}
