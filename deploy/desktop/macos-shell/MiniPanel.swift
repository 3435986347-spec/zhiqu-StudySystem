// 迷你番茄钟的悬浮面板（第五十一轮，docs/mini-pomodoro-plan.md 第 3 步）。
//
// 番茄钟卡片上点「缩小到桌面」：主窗口藏起来，屏幕上只剩一个半透明的深色胶囊（mini.html，像网易云的桌面歌词）——
// 总在最前、不抢焦点（点它不会把应用切到前台、打字的地方照样在别的应用里）、每个桌面空间和全屏应用旁边都在、能拖到任何地方、记住位置。
// 胶囊上点「展开」回到主窗口。页面和主窗口是同一份网站数据：同一个登录、同一个钟（第四十九轮）。
//
// 面板怎么配单独写成 makeMiniPanel，不放进 ZhiquShell.swift：那边有顶层代码和后端进程，检查程序没法和它一起编译 ——
// DesktopPageViewTest 把这一份和 PageView.swift 一起编进检查程序，建一个面板核对设定（不放到屏幕上）。

import AppKit
import WebKit

/// 胶囊中间（时间和小字那一块，没有能点的东西）：按住拖动整个面板。
///
/// WKWebView 把鼠标事件全吃了，`isMovableByWindowBackground` 对它盖住的地方不起作用（主窗口顶上的 DragStrip 是同一个道理）。
/// 两边的按钮（开始 / 暂停、展开）不盖，照常点得到。
final class MiniDragZone: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        return bounds.contains(convert(point, from: superview)) ? self : nil
    }
}

/// 无边框的面板默认当不了「键窗口」，里面的网页就收不到键盘（Tab 到按钮、空格按下去）；
/// 配了 .nonactivatingPanel，当键窗口也不会把应用切到前台。
final class MiniPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// 面板的大小：胶囊 56 高、四周留 6（页面里 .zq-main 的 margin，胶囊自己的影子画在这一圈里）
let miniPanelSize = NSSize(width: 300, height: 68)
/// 拖动区域：左边让开开始 / 暂停那个圆按钮（6 + 1 + 8 + 40），右边让开展开按钮（6 + 1 + 10 + 28）
let miniDragInsets = (left: CGFloat(60), right: CGFloat(50))
/// 记住位置用的名字（用户默认设置里）
let miniPanelAutosaveName = "ZhiquMiniPanel"

/// 建面板（不放到屏幕上）。第一次出现在主屏幕右上角，之后在上次拖到的地方。
func makeMiniPanel(page: PageView) -> NSPanel {
    let frame = NSRect(origin: .zero, size: miniPanelSize)
    let panel = MiniPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false               // 影子是页面里胶囊自己画的：窗口的影子是方的，会在胶囊外面描出一个方框
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.hidesOnDeactivate = false       // 面板默认在应用切到后台时藏起来 —— 迷你窗恰恰是给「在别的应用里干活」的时候看的
    panel.isMovableByWindowBackground = true
    panel.isReleasedWhenClosed = false
    panel.title = "迷你番茄钟"

    page.frame = frame
    page.autoresizingMask = [.width, .height]
    let content = NSView(frame: frame)
    content.addSubview(page)
    // 拖动区域压在页面上面：必须在 page 之后加，不然 page 盖住它
    let drag = MiniDragZone(frame: NSRect(x: miniDragInsets.left, y: 0,
                                          width: frame.width - miniDragInsets.left - miniDragInsets.right, height: frame.height))
    drag.autoresizingMask = [.width, .height]
    content.addSubview(drag)
    panel.contentView = content

    if !panel.setFrameUsingName(miniPanelAutosaveName), let screen = NSScreen.main?.visibleFrame {
        panel.setFrameOrigin(NSPoint(x: screen.maxX - frame.width - 24, y: screen.maxY - frame.height - 24))
    }
    panel.setFrameAutosaveName(miniPanelAutosaveName)
    return panel
}
