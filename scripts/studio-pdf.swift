import Foundation
import AppKit
import PDFKit
struct Request: Decodable { let input: String; let output: String; let preview: String; let pages: [Int]; let rotation: Int; let note: String }
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let request = try JSONDecoder().decode(Request.self, from: data)
    guard let document = PDFDocument(url: URL(fileURLWithPath: request.input)), !document.isLocked, document.pageCount > 0, document.pageCount <= 300 else { throw NSError(domain:"Studio",code:1,userInfo:[NSLocalizedDescriptionKey:"Choose an unlocked PDF with 1–300 pages."]) }
    let output = PDFDocument()
    for (index, number) in request.pages.enumerated() {
        guard number > 0, number <= document.pageCount, let page = document.page(at:number-1)?.copy() as? PDFPage else { throw NSError(domain:"Studio",code:2,userInfo:[NSLocalizedDescriptionKey:"Page is outside the PDF."]) }
        page.rotation = (page.rotation + request.rotation) % 360
        if !request.note.isEmpty { let annotation = PDFAnnotation(bounds:CGRect(x:20,y:20,width:24,height:24),forType:.text,withProperties:nil); annotation.contents = request.note; page.addAnnotation(annotation) }
        output.insert(page,at:index)
    }
    guard !FileManager.default.fileExists(atPath: request.output), output.write(to:URL(fileURLWithPath:request.output)), let verified=PDFDocument(url:URL(fileURLWithPath:request.output)), verified.pageCount==request.pages.count, let page=verified.page(at:0) else { throw NSError(domain:"Studio",code:3,userInfo:[NSLocalizedDescriptionKey:"PDF export validation failed."]) }
    let thumbnail=page.thumbnail(of:NSSize(width:900,height:900),for:.mediaBox)
    guard let tiff=thumbnail.tiffRepresentation, let bitmap=NSBitmapImageRep(data:tiff), let png=bitmap.representation(using:.png,properties:[:]) else { throw NSError(domain:"Studio",code:4,userInfo:[NSLocalizedDescriptionKey:"PDF preview failed."]) }
    try png.write(to:URL(fileURLWithPath:request.preview),options:.withoutOverwriting)
    let info:[String:Any] = ["pages":verified.pageCount,"engine":"Apple PDFKit","os":ProcessInfo.processInfo.operatingSystemVersionString,"rotation":request.rotation]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:info))
} catch { FileHandle.standardError.write(Data("PDF operation failed: \(error.localizedDescription)\n".utf8)); exit(1) }
