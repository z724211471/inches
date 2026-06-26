import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

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

type TranslationSettings = {
  provider: TranslationProviderId
  model: string
  apiKey: string
}

type SelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

type OcrProgressPayload = {
  imageDataUrl: string
  recognizedText: string
  sourceLanguage: string
  targetLanguage: string
  ocrProvider: string
}

const api = {
  captureAndTranslate: (request: CaptureRequest) => ipcRenderer.invoke('ocr:capture-and-translate', request),
  translateClipboardImage: (request: CaptureRequest) =>
    ipcRenderer.invoke('ocr:clipboard-and-translate', request),
  translateText: (request: TranslateRequest) => ipcRenderer.invoke('ocr:translate-text', request),
  getTranslationProviders: () => ipcRenderer.invoke('translation:get-providers'),
  getTranslationSettings: () => ipcRenderer.invoke('translation:get-settings'),
  saveTranslationSettings: (settings: TranslationSettings) => ipcRenderer.invoke('translation:save-settings', settings),
  getCaptureSession: () => ipcRenderer.invoke('capture:get-session'),
  submitCaptureSelection: (rect: SelectionRect) => ipcRenderer.invoke('capture:submit-selection', rect),
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),
  probeCaptureSupport: () => ipcRenderer.invoke('capture:probe'),
  onOcrProgress: (callback: (payload: OcrProgressPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: OcrProgressPayload): void => callback(payload)

    ipcRenderer.on('ocr:progress', listener)
    return () => ipcRenderer.removeListener('ocr:progress', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
