// 从设计稿生成应用图标（第七十二轮：知字图标设计方案，近黑圆角方块上一道白色螺旋线）。
//
// 第七十二轮之前这里是现画的：品牌色圆角方块 + 白色「知」。品牌色在第四十轮换成了中性配色，
// 图标却一直是旧的蓝底 —— 现在图标是设计稿，网页用的四张 PNG 就是设计稿原样（assets/icons/），
// 这里只做两件设计稿里没有的事：
//   1. macOS 的 iconset：按 macOS 图标的版式四周留白（1024 的画布里图标占 824），不然在 Dock 里比别的应用大一圈；
//   2. 两个 ICO：网页的 favicon.ico（16 / 32 / 48）、Windows 安装包的 zhiqu.ico（16 到 256 六档）。
//      16、32 用设计稿给小尺寸专门出的两张（线条做过取舍），更大的从 512 缩。
//
// 设计稿最大只有 512：iconset 最大那一档（512@2x，1024 像素）只能放大，最大的预览会有点软。
//
// 用法：MakeIcon <icon-512.png> <favicon-16.png> <favicon-32.png> <输出目录>
//   打包脚本每次只用 zhiqu.iconset；两个 ICO 换设计稿时手动拷回仓库：
//   cp <输出目录>/favicon.ico zhiqu-backend/src/main/resources/static/favicon.ico
//   cp <输出目录>/zhiqu.ico deploy/desktop/icon/zhiqu.ico

import AppKit

let args = CommandLine.arguments
guard args.count >= 5 else {
    FileHandle.standardError.write("用法: MakeIcon <icon-512.png> <favicon-16.png> <favicon-32.png> <outDir>\n".data(using: .utf8)!)
    exit(2)
}

func load(_ path: String) -> (CGImage, Data) {
    guard let data = FileManager.default.contents(atPath: path),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        FileHandle.standardError.write("读不了设计稿：\(path)\n".data(using: .utf8)!)
        exit(1)
    }
    return (image, data)
}
let (master, _) = load(args[1])
let (_, favicon16) = load(args[2])
let (_, favicon32) = load(args[3])
guard master.width == 512 && master.height == 512 else {
    FileHandle.standardError.write("icon-512.png 应当是 512×512，实际 \(master.width)×\(master.height)\n".data(using: .utf8)!)
    exit(1)
}
let outDir = URL(fileURLWithPath: args[4], isDirectory: true)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

/// 把设计稿缩放进 size × size 的画布，四周留 inset（占边长的比例），出 PNG。
func render(size: Int, inset ratio: CGFloat) -> Data? {
    let s = CGFloat(size)
    guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    rep.size = NSSize(width: s, height: s)
    let cg = context.cgContext
    cg.interpolationQuality = .high
    let pad = s * ratio
    cg.draw(master, in: CGRect(x: pad, y: pad, width: s - pad * 2, height: s - pad * 2))
    context.flushGraphics()
    return rep.representation(using: .png, properties: [:])
}

/// ICO：6 字节文件头 + 每张 16 字节目录 + 各张 PNG 原样（Vista 起都认 PNG 压缩的 ICO）。
func ico(_ images: [(Int, Data)]) -> Data {
    var out = Data()
    func le16(_ v: Int) { out.append(UInt8(v & 0xff)); out.append(UInt8(v >> 8 & 0xff)) }
    func le32(_ v: Int) { le16(v & 0xffff); le16(v >> 16 & 0xffff) }
    le16(0); le16(1); le16(images.count)
    var offset = 6 + 16 * images.count
    for (px, png) in images {
        out.append(UInt8(px >= 256 ? 0 : px)); out.append(UInt8(px >= 256 ? 0 : px))
        out.append(0); out.append(0)
        le16(1); le16(32)
        le32(png.count); le32(offset)
        offset += png.count
    }
    for (_, png) in images { out.append(png) }
    return out
}

func write(_ data: Data?, _ name: String) {
    guard let data else { print("  \(name) 生成失败"); exit(1) }
    try? data.write(to: outDir.appendingPathComponent(name))
    print("  \(name)  \(data.count / 1024)KB")
}

// ── macOS .iconset（1024 的画布里图标占 824，四周各留 100）──
let iconset = outDir.appendingPathComponent("zhiqu.iconset", isDirectory: true)
try? FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for (base, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
                      (256, 1), (256, 2), (512, 1), (512, 2)] {
    let px = base * scale
    let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
    guard let data = render(size: px, inset: 100.0 / 1024.0) else { print("  \(name) 生成失败"); exit(1) }
    try? data.write(to: iconset.appendingPathComponent(name))
}
print("  zhiqu.iconset/ （10 张，供 iconutil 打包）")

// ── ICO（铺满：标签页、任务栏那么小的地方不留白）──
write(ico([(16, favicon16), (32, favicon32), (48, render(size: 48, inset: 0)!)]), "favicon.ico")
write(ico([(16, favicon16), (32, favicon32)] + [48, 64, 128, 256].map { ($0, render(size: $0, inset: 0)!) }), "zhiqu.ico")
