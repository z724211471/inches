import {
  app,
  clipboard,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  shell
} from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { describeMacSystemCaptureError } from './capture-errors'
import {
  buildTranslateRequestFromCapture,
  type CaptureTranslationOptions,
  type TranslationProviderId
} from './translation-request'

const execFileAsync = promisify(execFile)
const HY_MT_MODEL = 'tencent/Hy-MT2-1.8B-GGUF:Q4_K_M'
const HY_MT_LOCAL_MODEL_SEGMENTS = ['Hy-MT2-1.8B-GGUF', 'Hy-MT2-1.8B-Q4_K_M.gguf']
const HY_MT_MAX_TOKENS = '512'
const HY_MT_TIMEOUT_MS = 10 * 60_000
const LLAMA_CLI_CANDIDATES = [
  process.env['LLAMA_CLI_PATH'],
  '/opt/homebrew/bin/llama-cli',
  '/usr/local/bin/llama-cli',
  'llama-cli'
].filter((item): item is string => Boolean(item))

app.commandLine.appendSwitch('enable-features', 'TranslationAPI,LanguageDetectionAPI')

type CaptureRequest = CaptureTranslationOptions

type TranslateRequest = {
  text: string
  sourceLanguage: string
  targetLanguage: string
  translationProvider?: TranslationProviderId
  onlineModel?: string
  onlineApiKey?: string
}

type TranslationResult = {
  provider: string
  text: string | null
  warning?: string
  elapsedMs?: number
}

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

type StoredTranslationSettings = {
  provider?: TranslationProviderId
  model?: string
  apiKey?: string
  apiKeyEncrypted?: boolean
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

type OcrProgressPayload = {
  imageDataUrl: string
  recognizedText: string
  sourceLanguage: string
  targetLanguage: string
  ocrProvider: string
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

const languageNames: Record<string, string> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁体中文',
  'en-US': '英语',
  'ja-JP': '日语',
  'ko-KR': '韩语',
  'fr-FR': '法语',
  'de-DE': '德语'
}

const translationProviders: TranslationProviderOption[] = [
  {
    id: 'hy-mt-local',
    label: '本地 Hy-MT2 1.8B GGUF',
    defaultModel: 'Hy-MT2-1.8B-Q4_K_M',
    requiresApiKey: false
  },
  {
    id: 'openai',
    label: 'ChatGPT / OpenAI',
    defaultModel: 'gpt-4o-mini',
    requiresApiKey: true
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true
  },
  {
    id: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-1.5-flash',
    requiresApiKey: true
  }
]

const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  provider: 'hy-mt-local',
  model: 'Hy-MT2-1.8B-Q4_K_M',
  apiKey: ''
}

const ONLINE_TRANSLATION_TIMEOUT_MS = 120_000

let mainWindow: BrowserWindow | null = null
const captureSessions = new Map<number, CaptureSession>()

function getTranslationSettingsPath(): string {
  return join(app.getPath('userData'), 'translation-settings.json')
}

function getTranslationProvider(provider?: string): TranslationProviderOption {
  return translationProviders.find((item) => item.id === provider) ?? translationProviders[0]
}

function normalizeTranslationSettings(settings: Partial<TranslationSettings>): TranslationSettings {
  const provider = getTranslationProvider(settings.provider).id
  return {
    provider,
    model: settings.model?.trim() || getTranslationProvider(provider).defaultModel,
    apiKey: settings.apiKey ?? ''
  }
}

function encryptApiKey(apiKey: string): Pick<StoredTranslationSettings, 'apiKey' | 'apiKeyEncrypted'> {
  if (!apiKey) {
    return { apiKey: '', apiKeyEncrypted: false }
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return { apiKey, apiKeyEncrypted: false }
  }

  return {
    apiKey: safeStorage.encryptString(apiKey).toString('base64'),
    apiKeyEncrypted: true
  }
}

function decryptApiKey(stored: StoredTranslationSettings): string {
  if (!stored.apiKey) {
    return ''
  }

  if (!stored.apiKeyEncrypted) {
    return stored.apiKey
  }

  try {
    return safeStorage.decryptString(Buffer.from(stored.apiKey, 'base64'))
  } catch {
    return ''
  }
}

async function loadTranslationSettings(): Promise<TranslationSettings> {
  try {
    const payload = JSON.parse(await fs.readFile(getTranslationSettingsPath(), 'utf8')) as StoredTranslationSettings
    return normalizeTranslationSettings({
      provider: payload.provider,
      model: payload.model,
      apiKey: decryptApiKey(payload)
    })
  } catch {
    return DEFAULT_TRANSLATION_SETTINGS
  }
}

async function saveTranslationSettings(settings: TranslationSettings): Promise<TranslationSettings> {
  const normalized = normalizeTranslationSettings(settings)
  const encrypted = encryptApiKey(normalized.apiKey)
  const stored: StoredTranslationSettings = {
    provider: normalized.provider,
    model: normalized.model,
    ...encrypted
  }

  await fs.writeFile(getTranslationSettingsPath(), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  return normalized
}

function shouldPreferSystemCapture(): boolean {
  return process.platform === 'darwin' && app.isPackaged
}

async function captureViaSystemTool(): Promise<Electron.NativeImage> {
  if (process.platform === 'darwin') {
    const filePath = join(tmpdir(), `system-capture-${Date.now()}.png`)
    try {
      await execFileAsync('screencapture', ['-i', '-x', filePath], { maxBuffer: 4 * 1024 * 1024 })
      const buffer = await fs.readFile(filePath)
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) {
        throw new Error('系统截图未返回图片内容。')
      }
      return image
    } catch (error) {
      throw new Error(describeMacSystemCaptureError(error))
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

async function translateText(request: TranslateRequest): Promise<TranslationResult> {
  const startedAt = performance.now()
  const provider = getTranslationProvider(request.translationProvider)
  let result: TranslationResult

  if (provider.id === 'hy-mt-local') {
    result = await translateWithHyMt(request)
  } else {
    result = await translateWithOnlineModel(request, provider)
  }

  return {
    ...result,
    elapsedMs: Math.round(performance.now() - startedAt)
  }
}

function getLanguageName(language: string): string {
  return languageNames[language] ?? language
}

function buildHyMtPrompt({ text, targetLanguage }: TranslateRequest): string {
  return `将以下文本翻译为 ${getLanguageName(targetLanguage)}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`
}

function buildOnlineMessages({ text, sourceLanguage, targetLanguage }: TranslateRequest): Array<{ role: string; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You are a precise translation engine. Return only the translated text. Do not explain, summarize, add markdown, or wrap the result in quotes.'
    },
    {
      role: 'user',
      content: `Translate from ${getLanguageName(sourceLanguage)} to ${getLanguageName(targetLanguage)}:\n\n${text}`
    }
  ]
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ONLINE_TRANSLATION_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    })
    const responseText = await response.text()
    const payload = responseText ? (JSON.parse(responseText) as unknown) : null

    if (!response.ok) {
      const message =
        typeof payload === 'object' && payload && 'error' in payload
          ? JSON.stringify((payload as { error: unknown }).error)
          : responseText
      throw new Error(`HTTP ${response.status}: ${message}`)
    }

    return payload
  } finally {
    clearTimeout(timeout)
  }
}

function extractOpenAiCompatibleText(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices
  return choices?.[0]?.message?.content?.trim() ?? ''
}

function extractGeminiText(payload: unknown): string {
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates
  return candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? ''
}

async function translateWithOpenAiCompatible(
  request: TranslateRequest,
  provider: TranslationProviderOption,
  endpoint: string
): Promise<TranslationResult> {
  const model = request.onlineModel?.trim() || provider.defaultModel
  const payload = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.onlineApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: buildOnlineMessages(request),
      temperature: 0.1
    })
  })

  return {
    provider: `${provider.label} (${model})`,
    text: extractOpenAiCompatibleText(payload) || null,
    warning: extractOpenAiCompatibleText(payload) ? undefined : '在线模型未返回翻译文本。'
  }
}

async function translateWithGemini(request: TranslateRequest, provider: TranslationProviderOption): Promise<TranslationResult> {
  const model = request.onlineModel?.trim() || provider.defaultModel
  const prompt = buildOnlineMessages(request)
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join('\n\n')
  const payload = await fetchJsonWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
      request.onlineApiKey ?? ''
    )}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.1
        }
      })
    }
  )

  const text = extractGeminiText(payload)
  return {
    provider: `${provider.label} (${model})`,
    text: text || null,
    warning: text ? undefined : 'Gemini 未返回翻译文本。'
  }
}

async function translateWithOnlineModel(
  request: TranslateRequest,
  provider: TranslationProviderOption
): Promise<TranslationResult> {
  if (!request.text.trim()) {
    return {
      provider: provider.label,
      text: null,
      warning: '没有可翻译的文本。'
    }
  }

  if (!request.onlineApiKey?.trim()) {
    return {
      provider: provider.label,
      text: null,
      warning: `${provider.label} 需要填写 API Key。`
    }
  }

  try {
    console.info(
      `[translate] using online provider=${provider.id} model=${request.onlineModel?.trim() || provider.defaultModel} chars=${request.text.length}`
    )

    if (provider.id === 'gemini') {
      return await translateWithGemini(request, provider)
    }

    const endpoint =
      provider.id === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://api.openai.com/v1/chat/completions'
    return await translateWithOpenAiCompatible(request, provider, endpoint)
  } catch (error) {
    return {
      provider: provider.label,
      text: null,
      warning: `在线模型翻译失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }

  return `${(ms / 1000).toFixed(1)}s`
}

async function resolveLlamaCliPath(): Promise<string> {
  for (const candidate of LLAMA_CLI_CANDIDATES) {
    if (candidate === 'llama-cli') {
      return candidate
    }

    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }

  return 'llama-cli'
}

async function resolveHyMtModelArgs(): Promise<string[]> {
  const appPath = app.getAppPath()
  const appBasePath = appPath.endsWith('.asar') ? appPath.slice(0, -5) : appPath
  const localModelCandidates = [
    process.env['HY_MT_MODEL_PATH'],
    join(process.cwd(), 'models', ...HY_MT_LOCAL_MODEL_SEGMENTS),
    join(appBasePath, 'models', ...HY_MT_LOCAL_MODEL_SEGMENTS),
    join(appBasePath + '.unpacked', 'models', ...HY_MT_LOCAL_MODEL_SEGMENTS),
    join(process.resourcesPath, 'app.asar.unpacked', 'models', ...HY_MT_LOCAL_MODEL_SEGMENTS),
    join(process.resourcesPath, 'models', ...HY_MT_LOCAL_MODEL_SEGMENTS)
  ].filter((item): item is string => Boolean(item))

  for (const candidate of localModelCandidates) {
    try {
      await fs.access(candidate)
      return ['-m', candidate]
    } catch {
      continue
    }
  }

  return ['-hf', HY_MT_MODEL]
}

function cleanHyMtOutput(output: string, prompt: string, sourceText: string): string {
  let text = output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\b\r]/g, '')
    .trim()

  const sourceIndex = text.lastIndexOf(sourceText)
  if (sourceIndex >= 0) {
    text = text.slice(sourceIndex + sourceText.length).trim()
  }

  const promptIndex = text.lastIndexOf(prompt)
  if (promptIndex >= 0) {
    text = text.slice(promptIndex + prompt.length).trim()
  }

  if (text.startsWith(prompt)) {
    text = text.slice(prompt.length).trim()
  }

  return text
    .replace(/\[ Prompt:[\s\S]*$/i, '')
    .replace(/Exiting\.\.\.[\s\S]*$/i, '')
    .split('\n')
    .map((line) => line.replace(/^[|/\\-]+\s*/, '').trimEnd())
    .filter((line) => {
      const trimmed = line.trim()
      return (
        trimmed &&
        !trimmed.startsWith('Loading model') &&
        !trimmed.startsWith('build      :') &&
        !trimmed.startsWith('model      :') &&
        !trimmed.startsWith('modalities :') &&
        !trimmed.startsWith('available commands:') &&
        !trimmed.startsWith('/exit') &&
        !trimmed.startsWith('/regen') &&
        !trimmed.startsWith('/clear') &&
        !trimmed.startsWith('/read') &&
        !trimmed.startsWith('/glob') &&
        !trimmed.startsWith('>') &&
        !trimmed.startsWith('▄▄') &&
        !trimmed.startsWith('██') &&
        !trimmed.startsWith('▀▀')
      )
    })
    .join('\n')
    .replace(/^翻译结果[:：]\s*/i, '')
    .replace(/^译文[:：]\s*/i, '')
    .trim()
}

function describeCliError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const details = error as Error & { code?: string | number; signal?: string; stderr?: string; stdout?: string }
  const parts = [error.message]

  if (details.code) {
    parts.push(`code=${details.code}`)
  }

  if (details.signal) {
    parts.push(`signal=${details.signal}`)
  }

  const stderr = details.stderr?.trim()
  if (stderr) {
    parts.push(stderr.slice(-1200))
  }

  const stdout = details.stdout?.trim()
  if (stdout) {
    parts.push(stdout.slice(-600))
  }

  return parts.join('\n')
}

async function translateWithHyMt(request: TranslateRequest): Promise<TranslationResult> {
  if (!request.text.trim()) {
    return {
      provider: 'Hy-MT2 1.8B GGUF',
      text: null,
      warning: '没有可翻译的文本。'
    }
  }

  const prompt = buildHyMtPrompt(request)

  try {
    const llamaCliPath = await resolveLlamaCliPath()
    const modelArgs = await resolveHyMtModelArgs()
    console.info(`[translate] starting ${modelArgs.join(' ')} with ${llamaCliPath}`)
    const { stdout, stderr } = await execFileAsync(
      llamaCliPath,
      [
        ...modelArgs,
        '--device',
        'none',
        '--single-turn',
        '--no-display-prompt',
        '--simple-io',
        '-p',
        prompt,
        '-n',
        HY_MT_MAX_TOKENS
      ],
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: HY_MT_TIMEOUT_MS
      }
    )
    const translatedText =
      cleanHyMtOutput(stdout, prompt, request.text) || cleanHyMtOutput(`${stdout}\n${stderr}`, prompt, request.text)
    console.info(`[translate] finished, output chars=${translatedText.length}, preview=${translatedText.slice(0, 80)}`)

    return {
      provider: 'Hy-MT2 1.8B GGUF',
      text: translatedText || null,
      warning: translatedText ? undefined : stderr.trim() || 'llama-cli 未返回翻译结果。'
    }
  } catch (error) {
    return {
      provider: 'Hy-MT2 1.8B GGUF',
      text: null,
      warning: `llama-cli 翻译失败: ${describeCliError(error)}`
    }
  }
}

function emitOcrProgress(payload: OcrProgressPayload): void {
  mainWindow?.webContents.send('ocr:progress', payload)
}

async function processImage(
  image: Electron.NativeImage,
  request: CaptureRequest,
  onOcrProgress?: (payload: OcrProgressPayload) => void
): Promise<ProcessedCapture> {
  const startedAt = performance.now()
  const imageDataUrl = image.toDataURL()
  const notices: string[] = []

  return withTempImage(image, 'snap-translate', async (imagePath) => {
    console.info('[capture] OCR starting')
    const ocrStartedAt = performance.now()
    const ocrResult = await recognizeText(imagePath, request.sourceLanguage)
    const ocrElapsedMs = Math.round(performance.now() - ocrStartedAt)
    console.info(`[capture] OCR finished, chars=${ocrResult.text.length}, elapsed=${formatElapsed(ocrElapsedMs)}`)
    onOcrProgress?.({
      imageDataUrl,
      recognizedText: ocrResult.text,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      ocrProvider: ocrResult.provider
    })

    const translation = await translateText(buildTranslateRequestFromCapture(ocrResult.text, request))
    const totalElapsedMs = Math.round(performance.now() - startedAt)

    if (translation.warning) {
      notices.push(translation.warning)
    }
    notices.push(
      `耗时统计：OCR ${formatElapsed(ocrElapsedMs)} · 翻译 ${translation.provider} ${formatElapsed(
        translation.elapsedMs ?? 0
      )} · 总计 ${formatElapsed(totalElapsedMs)}`
    )

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
    return processImage(fallbackImage, request, emitOcrProgress)
  }

  let image: Electron.NativeImage

  try {
    ;({ image } = await getDisplaySourceThumbnail())
  } catch {
    const fallbackImage = await captureViaSystemTool()
    return processImage(fallbackImage, request, emitOcrProgress)
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
    return processImage(image, request, emitOcrProgress)
  })

  ipcMain.handle('ocr:translate-text', async (_, request: TranslateRequest) => {
    return translateText(request)
  })

  ipcMain.handle('translation:get-providers', async () => {
    return translationProviders
  })

  ipcMain.handle('translation:get-settings', async () => {
    return loadTranslationSettings()
  })

  ipcMain.handle('translation:save-settings', async (_, settings: TranslationSettings) => {
    return saveTranslationSettings(settings)
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
    const sessionId = event.sender.id
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
    const request = session.request
    const resolveCapture = session.resolve
    const rejectCapture = session.reject

    captureSessions.delete(sessionId)
    if (!captureWindow.isDestroyed()) {
      captureWindow.destroy()
    }

    void processImage(cropped, request, emitOcrProgress).then(resolveCapture).catch(rejectCapture)
    return true
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
