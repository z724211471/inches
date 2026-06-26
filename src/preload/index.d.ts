import { ElectronAPI } from '@electron-toolkit/preload'

type CaptureRequest = {
  sourceLanguage: string
  targetLanguage: string
  translationProvider?: TranslationProviderId
  onlineModel?: string
  onlineApiKey?: string
}

type TranslateRequest = {
  text: string
  sourceLanguage: string
  targetLanguage: string
  translationProvider?: TranslationProviderId
  onlineModel?: string
  onlineApiKey?: string
}

type TranslationProviderId = 'hy-mt-local' | 'openai' | 'deepseek' | 'gemini'

type TranslationProviderOption = {
  id: TranslationProviderId
  label: string
  defaultModel: string
  requiresApiKey: boolean
}

type TranslationSettings = {
  provider: TranslationProviderId
  model: string
  apiKey: string
}

type TranslationResult = {
  provider: string
  text: string | null
  warning?: string
  elapsedMs?: number
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
  getTranslationProviders: () => Promise<TranslationProviderOption[]>
  getTranslationSettings: () => Promise<TranslationSettings>
  saveTranslationSettings: (settings: TranslationSettings) => Promise<TranslationSettings>
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
