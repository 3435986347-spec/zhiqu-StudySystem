// 从「知」字生成应用图标与网页图标。
//
// 为什么是生成而不是放一张设计稿：这个标识在界面里本来就是 CSS 画的
// （.zq-mark：品牌色圆角方块 + 白色「知」），仓库里从来没有对应的图片。
// 生成的好处是改品牌色时一条命令重出全套，不会出现「界面里是新色、图标还是旧色」。
//
// 用法：MakeIcon <输出目录>

import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: MakeIcon <outDir>\n".data(using: .utf8)!)
    exit(2)
}
let outDir = URL(fileURLWithPath: args[1], isDirectory: true)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

/// 品牌色，取自 assets/zhiqu-ui.css 基础 :root 的 --zq-primary。
let brand = NSColor(srgbRed: 0x2E / 255.0, green: 0x53 / 255.0, blue: 0x8F / 255.0, alpha: 1)

/// 画一张 size × size 的图标。
///
/// - Parameter inset: 圆角方块占画布的比例留白。macOS 的应用图标惯例是四周留白
///   （Dock 里图标之间才不会顶在一起）；网页 favicon 和 PWA 图标相反，要铺满，
///   否则在浏览器标签页那么小的尺寸上「知」会小到看不清。
func drawIcon(size: Int, inset ratio: CGFloat) -> Data? {
    let s = CGFloat(size)
    // 直接画进 NSBitmapImageRep，而不是 NSImage.lockFocus()。
    // lockFocus 那条路上 tiffRepresentation 必须在 unlockFocus **之后**调用；
    // 写成 defer 的话顺序正好反了，每一张都静默失败，只在控制台留一行
    // 「CGImageDestinationFinalize failed for output type 'public.tiff'」——
    // 这行字和「焦点没解锁」没有任何字面联系。
    guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    rep.size = NSSize(width: s, height: s)
    let context = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    defer { NSGraphicsContext.restoreGraphicsState() }

    NSGraphicsContext.current?.imageInterpolation = .high
    let pad = s * ratio
    let rect = NSRect(x: pad, y: pad, width: s - pad * 2, height: s - pad * 2)
    // 0.2237 是 macOS 圆角图标的比例（Big Sur 之后的 squircle 近似）。
    let radius = rect.width * 0.2237
    brand.setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()

    let glyph = "知" as NSString
    // 0.58 是试出来的：更大会让「知」的左右两半贴到圆角上，更小在 16px 下糊成一团。
    let fontSize = rect.width * 0.58
    let font = NSFont(name: "PingFang SC Semibold", size: fontSize)
        ?? NSFont(name: "Hiragino Sans W6", size: fontSize)
        ?? NSFont.boldSystemFont(ofSize: fontSize)
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor.white,
    ]
    let textSize = glyph.size(withAttributes: attrs)
    // 视觉居中而不是盒模型居中：CJK 字形的基线以下留白比以上多，
    // 直接按包围盒居中会看起来偏上。
    let origin = NSPoint(x: rect.midX - textSize.width / 2,
                         y: rect.midY - textSize.height / 2 + s * 0.012)
    glyph.draw(at: origin, withAttributes: attrs)
    context?.flushGraphics()

    return rep.representation(using: .png, properties: [:])
}

func write(_ data: Data?, _ name: String) {
    guard let data else { print("  \(name) 生成失败"); return }
    let url = outDir.appendingPathComponent(name)
    try? data.write(to: url)
    print("  \(name)  \(data.count / 1024)KB")
}

// ── macOS .iconset（留白，符合 Dock 惯例）──
let iconset = outDir.appendingPathComponent("zhiqu.iconset", isDirectory: true)
try? FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for (base, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
                      (256, 1), (256, 2), (512, 1), (512, 2)] {
    let px = base * scale
    let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
    if let data = drawIcon(size: px, inset: 0.085) {
        try? data.write(to: iconset.appendingPathComponent(name))
    }
}
print("  zhiqu.iconset/ （10 张，供 iconutil 打包）")

// ── 网页图标（铺满，小尺寸下才看得清）──
write(drawIcon(size: 192, inset: 0), "icon-192.png")
write(drawIcon(size: 512, inset: 0), "icon-512.png")
write(drawIcon(size: 180, inset: 0), "apple-touch-icon.png")
// maskable：Android 会把图标裁成圆形等形状，安全区是中心 80%，所以这一张要多留白。
write(drawIcon(size: 512, inset: 0.14), "icon-512-maskable.png")
