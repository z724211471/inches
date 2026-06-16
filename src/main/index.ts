import { app, clipboard, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const execFileAsync = promisify(execFile)

app.commandLine.appendSwitch('enable-features', 'TranslationAPI,LanguageDetectionAPI')

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

type CaptureSession = {
  request: CaptureRequest
  imageDataUrl: string
  imageWidth: number
  imageHeight: number
  resolve: (value: ProcessedCapture) => void
  reject: (reason?: unknown) => void
}

type SelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

type CaptureProbeResult = {
  preferredMode: 'overlay' | 'system-fallback'
  available: boolean
  message: string
}

let mainWindow: BrowserWindow | null = null
const captureSessions = new Map<number, CaptureSession>()

function shouldPreferSystemCapture(): boolean {
  return process.platform === 'darwin' && app.isPackaged
}

async function captureViaSystemTool(): Promise<Electron.NativeImage> {
  if (process.platform === 'darwin') {
    const filePath = join(tmpdir(), `system-capture-${Date.now()}.png`)
    await execFileAsync('screencapture', ['-i', '-x', filePath], { maxBuffer: 4 * 1024 * 1024 })

    try {
      const buffer = await fs.readFile(filePath)
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) {
        throw new Error('系统截图未返回图片内容。')
      }
      return image
    } finally {
      await fs.unlink(filePath).catch(() => undefined)
    }
  }

  if (process.platform === 'win32') {
    const initialImage = clipboard.readImage()
    const initialSignature = initialImage.isEmpty() ? '' : initialImage.toDataURL()

    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Start-Process "ms-screenclip:"'],
      { maxBuffer: 1024 * 1024 }
    )

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 350))
      const nextImage = clipboard.readImage()
      if (nextImage.isEmpty()) {
        continue
      }

      const nextSignature = nextImage.toDataURL()
      if (nextSignature != initialSignature) {
        return nextImage
      }
    }

    throw new Error('Windows 系统截图超时，请重试。')
  }

  throw new Error('当前只实现了 macOS 与 Windows 的系统截图流程。')
}

function getRendererEntry(hash = ''): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}${hash}`
  }

  const indexFile = join(__dirname, '../renderer/index.html')
  return hash ? `${indexFile}${hash}` : indexFile
}

async function loadWindow(window: BrowserWindow, hash = ''): Promise<void> {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await window.loadURL(getRendererEntry(hash))
    return
  }

  await window.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash: hash.replace('#', '') } : {})
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    title: 'Snap Translate OCR',
    backgroundColor: '#06131f',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  void loadWindow(mainWindow)
}

function getNativeAssetPath(...segments: string[]): string {
  const appPath = app.getAppPath()
  const appBasePath = appPath.endsWith('.asar') ? appPath.slice(0, -5) : appPath
  const candidates = [
    join(appBasePath, 'resources', ...segments),
    join(`${appBasePath}.unpacked`, 'resources', ...segments),
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', ...segments),
    join(process.resourcesPath, 'resources', ...segments),
    join(process.cwd(), 'resources', ...segments)
  ]

  for (const candidate of candidates) {
    try {
      const stat = require('fs').statSync(candidate)
      if (stat.isFile()) {
        return candidate
      }
    } catch {
      continue
    }
  }

  throw new Error(`Native asset not found: resources/${segments.join('/')} (searched: ${candidates.join(', ')})`)
}

async function runMacOcr(imagePath: string, language: string): Promise<{ provider: string; text: string }> {
  const scriptPath = getNativeAssetPath('native', 'macos-ocr.swift')
  const { stdout, stderr } = await execFileAsync('xcrun', ['swift', scriptPath, imagePath, language], {
    maxBuffer: 10 * 1024 * 1024
  })

  if (stderr.trim()) {
    console.warn(stderr)
  }

  const payload = JSON.parse(stdout) as { text?: string; provider?: string; error?: string }
  if (payload.error) {
    throw new Error(payload.error)
  }

  return {
    provider: payload.provider ?? 'Apple Vision OCR',
    text: payload.text?.trim() ?? ''
  }
}

async function runWindowsOcr(imagePath: string, language: string): Promise<{ provider: string; text: string }> {
  const scriptPath = getNativeAssetPath('native', 'windows-ocr.ps1')
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ImagePath', imagePath, '-Language', language],
    { maxBuffer: 10 * 1024 * 1024 }
  )

  if (stderr.trim()) {
    console.warn(stderr)
  }

  const payload = JSON.parse(stdout) as { text?: string; provider?: string; error?: string }
  if (payload.error) {
    throw new Error(payload.error)
  }

  return {
    provider: payload.provider ?? 'Windows Media OCR',
    text: payload.text?.trim() ?? ''
  }
}

async function recognizeText(imagePath: string, language: string): Promise<{ provider: string; text: string }> {
  if (process.platform === 'darwin') {
    return runMacOcr(imagePath, language)
  }

  if (process.platform === 'win32') {
    return runWindowsOcr(imagePath, language)
  }

  throw new Error('当前只实现了 macOS 与 Windows 的本地 OCR。')
}

async function withTempImage<T>(image: Electron.NativeImage, prefix: string, task: (filePath: string) => Promise<T>): Promise<T> {
  const filePath = join(tmpdir(), `${prefix}-${Date.now()}.png`)
  await fs.writeFile(filePath, image.toPNG())

  try {
    return await task(filePath)
  } finally {
    await fs.unlink(filePath).catch(() => undefined)
  }
}

async function captureFromClipboard(): Promise<Electron.NativeImage> {
  const image = clipboard.readImage()
  if (image.isEmpty()) {
    throw new Error('剪贴板里没有图片。请先截图，或直接点“框选截图并翻译”。')
  }

  return image
}

async function translateWithRuntimeApi({ text, sourceLanguage, targetLanguage }: TranslateRequest): Promise<TranslationResult> {
  const translatorWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: false
    }
  })

  try {
    await translatorWindow.loadURL('data:text/html;charset=utf-8,<html><body></body></html>')

    const result = (await translatorWindow.webContents.executeJavaScript(
      `(${async ({ inputText, source, target }) => {
        const response = {
          provider: 'Chromium Translator API',
          text: null,
          warning: undefined
        } as any

        try {
          if (!inputText.trim()) {
            response.warning = '没有可翻译的文本。'
            return response
          }

          const translationAPI = (window as any).translation
          if (typeof translationAPI === 'undefined') {
            response.warning = '当前运行时没有暴露 Translation API。'
            return response
          }

          const availability = await translationAPI.canTranslate({
            sourceLanguage: source,
            targetLanguage: target
          })

          if (availability === 'no') {
            response.warning = '当前系统未提供可用的本地翻译模型。'
            return response
          }

          const translator = await translationAPI.createGenericTranslator({
            sourceLanguage: source,
            targetLanguage: target
          })

          response.text = await translator.translate(inputText)
          if (translator && typeof translator.destroy === 'function') {
            translator.destroy()
          }

          return response
        } catch (error) {
          response.warning = error instanceof Error ? error.message : String(error)
          return response
        }
      }})(${JSON.stringify({ inputText: text, source: sourceLanguage, target: targetLanguage })})`,
      true
    )) as TranslationResult

    return result
  } finally {
    translatorWindow.destroy()
  }
}

async function translateText(request: TranslateRequest): Promise<TranslationResult> {
  return translateWithRuntimeApi(request)
}

async function processImage(image: Electron.NativeImage, request: CaptureRequest): Promise<ProcessedCapture> {
  const imageDataUrl = image.toDataURL()
  const notices: string[] = []

  return withTempImage(image, 'snap-translate', async (imagePath) => {
    const ocrResult = await recognizeText(imagePath, request.sourceLanguage)
    const translation = await translateText({
      text: ocrResult.text,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage
    })

    if (translation.warning) {
      notices.push(translation.warning)
    }

    return {
      imageDataUrl,
      recognizedText: ocrResult.text,
      translatedText: translation.text,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      ocrProvider: ocrResult.provider,
      translationProvider: translation.provider,
      notices
    }
  })
}


function describeCaptureSourceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  if (process.platform === 'darwin') {
    return `无法读取屏幕内容。macOS 通常是因为没有授予“屏幕录制”权限。请到“系统设置 > 隐私与安全性 > 屏幕录制”里勾选当前应用后重试。原始错误: ${message}`
  }

  if (process.platform === 'win32') {
    return `无法读取屏幕内容。请确认当前桌面会话可见、没有被远程限制，并重试。原始错误: ${message}`
  }

  return `无法读取屏幕内容: ${message}`
}

async function getDisplaySourceThumbnail(): Promise<{ image: Electron.NativeImage; displayId: number }> {
  const cursorPoint = screen.getCursorScreenPoint()
  const activeDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const size = {
    width: Math.max(1, Math.floor(activeDisplay.size.width * activeDisplay.scaleFactor)),
    height: Math.max(1, Math.floor(activeDisplay.size.height * activeDisplay.scaleFactor))
  }

  let sources

  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: size,
      fetchWindowIcons: false
    })
  } catch (error) {
    throw new Error(describeCaptureSourceError(error))
  }

  const matchedSource =
    sources.find((source) => source.display_id === String(activeDisplay.id)) ??
    sources.find((source) => source.thumbnail.getSize().width === size.width) ??
    sources[0]

  if (!matchedSource || matchedSource.thumbnail.isEmpty()) {
    throw new Error(describeCaptureSourceError('没有拿到可用的屏幕缩略图。'))
  }

  return {
    image: matchedSource.thumbnail,
    displayId: activeDisplay.id
  }
}


async function probeCaptureSupport(): Promise<CaptureProbeResult> {
  if (shouldPreferSystemCapture()) {
    return {
      preferredMode: 'system-fallback',
      available: true,
      message:
        '当前 mac 打包版默认使用系统截图，以避免替换 .app 后反复触发屏幕录制权限校验。点击截图时会直接走系统选区截图。'
    }
  }

  try {
    await getDisplaySourceThumbnail()
    return {
      preferredMode: 'overlay',
      available: true,
      message: '应用内覆盖层截图可用，点击按钮后会直接进入框选翻译。'
    }
  } catch (error) {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      return {
        preferredMode: 'system-fallback',
        available: true,
        message: `应用内覆盖层当前不可用，将自动回退到系统截图。原因: ${describeCaptureSourceError(error)}`
      }
    }

    return {
      preferredMode: 'system-fallback',
      available: false,
      message: describeCaptureSourceError(error)
    }
  }
}

async function startOverlayCapture(request: CaptureRequest): Promise<ProcessedCapture> {
  if (shouldPreferSystemCapture()) {
    const fallbackImage = await captureViaSystemTool()
    return processImage(fallbackImage, request)
  }

  let image: Electron.NativeImage

  try {
    ;({ image } = await getDisplaySourceThumbnail())
  } catch {
    const fallbackImage = await captureViaSystemTool()
    return processImage(fallbackImage, request)
  }
  const imageSize = image.getSize()

  return new Promise<ProcessedCapture>(async (resolve, reject) => {
    const cursorPoint = screen.getCursorScreenPoint()
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint)
    const captureWindow = new BrowserWindow({
      x: activeDisplay.bounds.x,
      y: activeDisplay.bounds.y,
      width: activeDisplay.bounds.width,
      height: activeDisplay.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      focusable: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    const captureWindowId = captureWindow.webContents.id
    let settled = false

    const resolveOnce = (value: ProcessedCapture): void => {
      if (settled) {
        return
      }

      settled = true
      resolve(value)
    }

    const rejectOnce = (reason: unknown): void => {
      if (settled) {
        return
      }

      settled = true
      reject(reason)
    }

    captureSessions.set(captureWindowId, {
      request,
      imageDataUrl: image.toDataURL(),
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
      resolve: resolveOnce,
      reject: rejectOnce
    })

    captureWindow.on('closed', () => {
      const session = captureSessions.get(captureWindowId)
      if (session) {
        captureSessions.delete(captureWindowId)
        rejectOnce(new Error('截图已取消。'))
      }
    })

    try {
      await loadWindow(captureWindow, '#capture')
      captureWindow.show()
      captureWindow.focus()
    } catch (error) {
      captureSessions.delete(captureWindowId)
      if (!captureWindow.isDestroyed()) {
        captureWindow.destroy()
      }
      rejectOnce(error)
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('ocr:capture-and-translate', async (_, request: CaptureRequest) => {
    return startOverlayCapture(request)
  })

  ipcMain.handle('ocr:clipboard-and-translate', async (_, request: CaptureRequest) => {
    const image = await captureFromClipboard()
    return processImage(image, request)
  })

  ipcMain.handle('ocr:translate-text', async (_, request: TranslateRequest) => {
    return translateText(request)
  })

  ipcMain.handle('capture:get-session', async (event) => {
    const session = captureSessions.get(event.sender.id)
    if (!session) {
      throw new Error('当前没有进行中的截图会话。')
    }

    return {
      imageDataUrl: session.imageDataUrl,
      imageWidth: session.imageWidth,
      imageHeight: session.imageHeight
    }
  })

  ipcMain.handle('capture:submit-selection', async (event, rect: SelectionRect) => {
    const session = captureSessions.get(event.sender.id)
    const captureWindow = BrowserWindow.fromWebContents(event.sender)

    if (!session || !captureWindow) {
      throw new Error('截图会话已失效。')
    }

    if (rect.width < 4 || rect.height < 4) {
      throw new Error('截图区域太小，请重新框选。')
    }

    const sourceImage = nativeImage.createFromDataURL(session.imageDataUrl)
    const cropped = sourceImage.crop({
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height))
    })

    try {
      const result = await processImage(cropped, session.request)
      session.resolve(result)
      captureSessions.delete(event.sender.id)
      captureWindow.destroy()
      return true
    } catch (error) {
      session.reject(error)
      captureSessions.delete(event.sender.id)
      captureWindow.destroy()
      throw error
    }
  })

  ipcMain.handle('capture:probe', async () => {
    return probeCaptureSupport()
  })

  ipcMain.handle('capture:cancel', async (event) => {
    const session = captureSessions.get(event.sender.id)
    const captureWindow = BrowserWindow.fromWebContents(event.sender)

    if (session) {
      session.reject(new Error('截图已取消。'))
      captureSessions.delete(event.sender.id)
    }

    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.destroy()
    }

    return true
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
