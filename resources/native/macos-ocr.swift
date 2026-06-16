import Foundation
import Vision

struct Response: Encodable {
    let provider: String
    let text: String
    let error: String?
}

func printResponse(_ response: Response) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = []
    if let data = try? encoder.encode(response), let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"provider\":\"Apple Vision OCR\",\"text\":\"\",\"error\":\"Failed to encode JSON response.\"}")
    }
}

guard CommandLine.arguments.count >= 2 else {
    printResponse(Response(provider: "Apple Vision OCR", text: "", error: "Missing image path."))
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let language = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "en-US"
let imageURL = URL(fileURLWithPath: imagePath)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if !language.isEmpty {
    request.recognitionLanguages = [language]
}

do {
    let handler = VNImageRequestHandler(url: imageURL)
    try handler.perform([request])

    let text = (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")

    printResponse(Response(provider: "Apple Vision OCR", text: text, error: nil))
} catch {
    printResponse(Response(provider: "Apple Vision OCR", text: "", error: error.localizedDescription))
    exit(1)
}
