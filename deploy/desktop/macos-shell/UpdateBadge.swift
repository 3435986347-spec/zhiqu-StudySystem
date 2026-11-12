//
//  UpdateBadge.swift
//  左下角那颗「有新版本」的胶囊（第一百三十二轮）。
//
//  用户要的样子（codex / dsh 那样）：不弹窗、不打断，左下角一颗小胶囊，点一下自己下载，
//  下载完再点一下重启。没新版本时它根本不出现。
//

import AppKit

final class UpdateBadge: NSView {

    /// 点了胶囊（有新版本 → 下载；下载完 → 重启）
    var onClick: (() -> Void)?
    /// 点了右边的 ×（这个版本不再提示）
    var onSkip: (() -> Void)?

    private let icon = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private let close = NSButton()
    private let stack = NSStackView()
    private var clickable = false
    private var hovering = false
    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 18
        layer?.borderWidth = 1
        layer?.shadowOpacity = 0.16
        layer?.shadowRadius = 10
        layer?.shadowOffset = CGSize(width: 0, height: -2)
        applyColors()

        icon.imageScaling = .scaleProportionallyDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 16).isActive = true

        label.font = .systemFont(ofSize: 12.5, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1

        close.isBordered = false
        close.bezelStyle = .inline
        close.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "不再提示")
        close.imagePosition = .imageOnly
        close.contentTintColor = .tertiaryLabelColor
        close.target = self
        close.action = #selector(skip)
        close.translatesAutoresizingMaskIntoConstraints = false
        close.widthAnchor.constraint(equalToConstant: 14).isActive = true
        close.heightAnchor.constraint(equalToConstant: 14).isActive = true

        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(icon)
        stack.addArrangedSubview(label)
        stack.addArrangedSubview(close)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("UpdateBadge 只从代码里建") }

    override var intrinsicContentSize: NSSize { stack.fittingSize }

    /// 跟着服务器上的状态换字。`.idle` 时自己藏起来。
    func show(_ phase: UpdatePhase) {
        switch phase {
        case .idle:
            isHidden = true
            return
        case .available(let r):
            set(icon: "arrow.down.circle.fill", tint: .controlAccentColor,
                text: "有新版本 \(r.version)", clickable: true, showClose: true)
        case .downloading(let received, let total):
            let percent = total > 0 ? Int((Double(received) / Double(total) * 100).rounded()) : 0
            set(icon: "arrow.down.circle", tint: .secondaryLabelColor,
                text: "正在下载 \(percent)%", clickable: false, showClose: false)
        case .ready(let r):
            set(icon: "arrow.clockwise.circle.fill", tint: .controlAccentColor,
                text: "重启完成更新 \(r.version)", clickable: true, showClose: true)
        case .installing:
            set(icon: "arrow.triangle.2.circlepath", tint: .secondaryLabelColor,
                text: "正在更新…", clickable: false, showClose: false)
        case .failed(let why):
            set(icon: "exclamationmark.triangle.fill", tint: .systemOrange,
                text: why, clickable: false, showClose: true)
        }
        isHidden = false
        needsLayout = true
        invalidateIntrinsicContentSize()
    }

    private func set(icon name: String, tint: NSColor, text: String, clickable: Bool, showClose: Bool) {
        icon.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)
        icon.contentTintColor = tint
        label.stringValue = text
        label.textColor = .labelColor
        self.clickable = clickable
        close.isHidden = !showClose
    }

    private func applyColors() {
        layer?.backgroundColor = (hovering && clickable
            ? NSColor.controlBackgroundColor.blended(withFraction: 0.08, of: .labelColor) ?? .controlBackgroundColor
            : NSColor.controlBackgroundColor).cgColor
        layer?.borderColor = NSColor.separatorColor.cgColor
    }

    // MARK: - 鼠标

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        applyColors()
        if clickable { NSCursor.pointingHand.push() }
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        applyColors()
        if clickable { NSCursor.pop() }
    }

    override func mouseDown(with event: NSEvent) {
        guard clickable else { return }
        onClick?()
    }

    /// 胶囊在网页上面：不吃掉自己范围外的点击
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden else { return nil }
        let inside = bounds.contains(convert(point, from: superview))
        return inside ? super.hitTest(point) : nil
    }

    @objc private func skip() { onSkip?() }
}
