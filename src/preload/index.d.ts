import { ElectronAPI } from '@electron-toolkit/preload'

type CaptureRequest = {
  sourceLanguage: string
  targetLanguage: string
}

type TranslateRequest = {
  text: string
  sourceLanguage: string
  targetLanguage: string
}

type TranslationResult = {
  provider: string
  text: string | null
  warning?: string
}

type ProcessedCapture = {
  imageDataUrl: string
  recognizedText: string
  translatedText: string | null
  sourceLanguage: string
  targetLanguage: string
  ocrProvider: string
  translationProvider: string
  notices: string[]
}

type SelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

type CaptureSessionPayload = {
  imageDataUrl: string
  imageWidth: number
  imageHeight: number
}

type CaptureProbeResult = {
  preferredMode: 'overlay' | 'system-fallback'
  available: boolean
  message: string
}

type OcrProgressPayload = {
  imageDataUrl: string
  recognizedText: string
  sourceLanguage: string
  targetLanguage: string
  ocrProvider: string
}

type SnapTranslateApi = {
  captureAndTranslate: (request: CaptureRequest) => Promise<ProcessedCapture>
  translateClipboardImage: (request: CaptureRequest) => Promise<ProcessedCapture>
  translateText: (request: TranslateRequest) => Promise<TranslationResult>
  getCaptureSession: () => Promise<CaptureSessionPayload>
  submitCaptureSelection: (rect: SelectionRect) => Promise<boolean>
  cancelCapture: () => Promise<boolean>
  probeCaptureSupport: () => Promise<CaptureProbeResult>
  onOcrProgress: (callback: (payload: OcrProgressPayload) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: SnapTranslateApi
  }
}
