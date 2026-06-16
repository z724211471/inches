import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type CaptureRequest = {
  sourceLanguage: string
  targetLanguage: string
}

type TranslateRequest = {
  text: string
  sourceLanguage: string
  targetLanguage: string
}

type SelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

const api = {
  captureAndTranslate: (request: CaptureRequest) => ipcRenderer.invoke('ocr:capture-and-translate', request),
  translateClipboardImage: (request: CaptureRequest) =>
    ipcRenderer.invoke('ocr:clipboard-and-translate', request),
  translateText: (request: TranslateRequest) => ipcRenderer.invoke('ocr:translate-text', request),
  getCaptureSession: () => ipcRenderer.invoke('capture:get-session'),
  submitCaptureSelection: (rect: SelectionRect) => ipcRenderer.invoke('capture:submit-selection', rect),
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),
  probeCaptureSupport: () => ipcRenderer.invoke('capture:probe')
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
