package com.zhiqu.cli;

import java.util.function.Consumer;

/**
 * 按行喂进来的 Server-Sent Events 解析器。
 *
 * <p>Spring 的 {@code SseEmitter} 发的是 {@code event:名字\ndata:{json}\n\n}（冒号后面<b>没有空格</b>），
 * 浏览器的 EventSource 两种都认；这里也两种都认。多行 {@code data:} 按规范用换行拼起来。
 * 以冒号开头的是注释行（心跳），忽略。流在最后一个事件后没有空行就断了时，
 * 调用 {@link #end()} 把它补发出去 —— 否则最后一条（往往就是 {@code done}）会丢。
 */
public final class SseParser {

    public record Event(String name, String data) {
    }

    private final Consumer<Event> sink;
    private String name;
    private StringBuilder data;

    public SseParser(Consumer<Event> sink) {
        this.sink = sink;
    }

    public void line(String raw) {
        String line = raw != null && raw.endsWith("\r") ? raw.substring(0, raw.length() - 1) : raw;
        if (line == null || line.isEmpty()) {
            dispatch();
            return;
        }
        if (line.startsWith(":")) {
            return;
        }
        int colon = line.indexOf(':');
        String field = colon < 0 ? line : line.substring(0, colon);
        String value = colon < 0 ? "" : line.substring(colon + 1);
        if (value.startsWith(" ")) {
            value = value.substring(1);
        }
        if ("event".equals(field)) {
            name = value;
        } else if ("data".equals(field)) {
            if (data == null) {
                data = new StringBuilder();
            } else {
                data.append('\n');
            }
            data.append(value);
        }
    }

    public void end() {
        dispatch();
    }

    private void dispatch() {
        if (data != null) {
            sink.accept(new Event(name == null || name.isEmpty() ? "message" : name, data.toString()));
        }
        name = null;
        data = null;
    }
}
