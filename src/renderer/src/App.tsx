import { useEffect, useMemo, useState } from 'react'

type CaptureResult = Awaited<ReturnType<typeof window.api.captureAndTranslate>>
type TranslateResult = Awaited<ReturnType<typeof window.api.translateText>>
type CaptureSessionPayload = Awaited<ReturnType<typeof window.api.getCaptureSession>>
type CaptureProbeResult = Awaited<ReturnType<typeof window.api.probeCaptureSupport>>
type OcrProgress = Parameters<Parameters<typeof window.api.onOcrProgress>[0]>[0]

type LanguageOption = {
  label: string
  value: string
}

type DragState = {
  startX: number
  startY: number
  currentX: number
  currentY: number
}

const sourceLanguages: LanguageOption[] = [
  { label: '自动倾向英文', value: 'en-US' },
  { label: '简体中文', value: 'zh-Hans' },
  { label: '繁体中文', value: 'zh-Hant' },
  { label: '英文', value: 'en-US' },
  { label: '日文', value: 'ja-JP' },
  { label: '韩文', value: 'ko-KR' },
  { label: '法文', value: 'fr-FR' },
  { label: '德文', value: 'de-DE' }
]

const targetLanguages: LanguageOption[] = [
  { label: '翻译成简体中文', value: 'zh-Hans' },
  { label: '翻译成英文', value: 'en-US' },
  { label: '翻译成日文', value: 'ja-JP' },
  { label: '翻译成韩文', value: 'ko-KR' },
  { label: '翻译成法文', value: 'fr-FR' }
]

function normalizeRect(drag: DragState) {
  const left = Math.min(drag.startX, drag.currentX)
  const top = Math.min(drag.startY, drag.currentY)
  const width = Math.abs(drag.currentX - drag.startX)
  const height = Math.abs(drag.currentY - drag.startY)

  return { left, top, width, height }
}

function CaptureOverlay(): React.JSX.Element {
  const [session, setSession] = useState<CaptureSessionPayload | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api
      .getCaptureSession()
      .then((payload) => setSession(payload))
      .catch((captureError) => {
        setError(captureError instanceof Error ? captureError.message : String(captureError))
      })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        void window.api.cancelCapture()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rect = drag ? normalizeRect(drag) : null

  async function submitSelection(nextRect: { left: number; top: number; width: number; height: number }): Promise<void> {
    if (!session) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const ratioX = session.imageWidth / window.innerWidth
      const ratioY = session.imageHeight / window.innerHeight

      await window.api.submitCaptureSelection({
        x: nextRect.left * ratioX,
        y: nextRect.top * ratioY,
        width: nextRect.width * ratioX,
        height: nextRect.height * ratioY
      })
    } catch (captureError) {
      setSubmitting(false)
      setError(captureError instanceof Error ? captureError.message : String(captureError))
    }
  }

  return (
    <div className="capture-overlay-root">
      {session && (
        <div
          className="capture-surface"
          style={{ backgroundImage: 'url(' + session.imageDataUrl + ')' }}
          onMouseDown={(event) => {
            if (submitting) {
              return
            }

            setDrag({
              startX: event.clientX,
              startY: event.clientY,
              currentX: event.clientX,
              currentY: event.clientY
            })
          }}
          onMouseMove={(event) => {
            setDrag((current) =>
              current
                ? {
                    ...current,
                    currentX: event.clientX,
                    currentY: event.clientY
                  }
                : null
            )
          }}
          onMouseUp={() => {
            if (!drag) {
              return
            }

            const nextRect = normalizeRect(drag)
            setDrag(null)
            void submitSelection(nextRect)
          }}
        >
          <div className="capture-toolbar">
            <div>
              <strong>拖拽框选翻译区域</strong>
              <p>松开鼠标后立即开始 OCR 与翻译，按 Esc 可取消。</p>
            </div>
            <button type="button" className="text-button" onClick={() => void window.api.cancelCapture()}>
              取消
            </button>
          </div>

          <div className="capture-mask" />

          {rect && (
            <div
              className="capture-selection"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height
              }}
            />
          )}

          {submitting && <div className="capture-status">正在识别并翻译...</div>}
          {error && <div className="capture-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

function MainWorkspace(): React.JSX.Element {
  const [sourceLanguage, setSourceLanguage] = useState('en-US')
  const [targetLanguage, setTargetLanguage] = useState('zh-Hans')
  const [result, setResult] = useState<CaptureResult | null>(null)
  const [partialOcr, setPartialOcr] = useState<OcrProgress | null>(null)
  const [manualText, setManualText] = useState('')
  const [manualTranslation, setManualTranslation] = useState<TranslateResult | null>(null)
  const [busyAction, setBusyAction] = useState<'capture' | 'clipboard' | 'manual' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<CaptureProbeResult | null>(null)
  const [probing, setProbing] = useState(false)

  const sourceLabel = useMemo(
    () => sourceLanguages.find((item) => item.value === sourceLanguage)?.label ?? sourceLanguage,
    [sourceLanguage]
  )
  const targetLabel = useMemo(
    () => targetLanguages.find((item) => item.value === targetLanguage)?.label ?? targetLanguage,
    [targetLanguage]
  )
  const busyHint =
    busyAction === 'capture'
      ? '正在截图、OCR 识别并调用本地 Hy-MT2 模型翻译。首次运行可能需要下载或加载模型，请稍等。'
      : busyAction === 'clipboard'
        ? '正在读取剪贴板图片、OCR 识别并调用本地 Hy-MT2 模型翻译。'
        : busyAction === 'manual'
          ? '正在调用本地 Hy-MT2 模型翻译文本。'
          : null

  async function refreshProbe(): Promise<void> {
    setProbing(true)

    try {
      const nextProbe = await window.api.probeCaptureSupport()
      setProbe(nextProbe)
    } catch (probeError) {
      setProbe({
        preferredMode: 'system-fallback',
        available: false,
        message: probeError instanceof Error ? probeError.message : String(probeError)
      })
    } finally {
      setProbing(false)
    }
  }

  useEffect(() => {
    void refreshProbe()
  }, [])

  useEffect(() => {
    return window.api.onOcrProgress((payload) => {
      setPartialOcr(payload)
    })
  }, [])

  async function runAction(action: 'capture' | 'clipboard'): Promise<void> {
    setBusyAction(action)
    setError(null)
    setPartialOcr(null)

    try {
      const response =
        action === 'capture'
          ? await window.api.captureAndTranslate({ sourceLanguage, targetLanguage })
          : await window.api.translateClipboardImage({ sourceLanguage, targetLanguage })

      setResult(response)
      setPartialOcr(null)
      if (action === 'capture') {
        void refreshProbe()
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
      if (action === 'capture') {
        void refreshProbe()
      }
    } finally {
      setBusyAction(null)
    }
  }

  async function translateManualText(): Promise<void> {
    setBusyAction('manual')
    setError(null)

    try {
      const response = await window.api.translateText({
        text: manualText,
        sourceLanguage,
        targetLanguage
      })
      setManualTranslation(response)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Snap Translate OCR</p>
          <h1>框选截图后，松手立即翻译</h1>
          <p className="hero-text">
            mac 打包版默认直接走系统截图，尽量避免替换 .app 后反复触发录屏权限问题；其余环境仍会优先尝试应用内覆盖层。
          </p>
        </div>

        <div className="platform-note">
          <span className="platform-pill">macOS</span>
          <span className="platform-pill">Windows</span>
          <span className="platform-meta">框选即翻译</span>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel control-panel">
          <h2>开始使用</h2>
          <p className="panel-subtitle">mac 打包版默认调起系统截图；如果当前环境允许，也会显示应用内框选层。</p>

          <div className="status-card">
            <div className="status-head">
              <h3>当前截图模式</h3>
              <button
                className="text-button"
                type="button"
                onClick={() => void refreshProbe()}
                disabled={probing || busyAction !== null}
              >
                {probing ? '检测中...' : '检测截图能力'}
              </button>
            </div>
            {probe ? (
              <>
                <div className="status-badges">
                  <span className={probe.preferredMode === 'overlay' ? 'mode-badge mode-ok' : 'mode-badge mode-fallback'}>
                    {probe.preferredMode === 'overlay' ? '应用内覆盖层' : '系统截图兜底'}
                  </span>
                  <span className={probe.available ? 'mode-badge mode-ready' : 'mode-badge mode-error'}>
                    {probe.available ? '可用' : '不可用'}
                  </span>
                </div>
                <p className="status-message">{probe.message}</p>
                <p className="status-message">
                  替换 mac 打包版 app 后如果又弹权限，优先删除旧 app、重新放入 `/Applications`，再重试。
                </p>
              </>
            ) : (
              <p className="status-message">正在检测截图能力...</p>
            )}
          </div>

          <div className="field-grid">
            <label className="field">
              <span>原文语言</span>
              <select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)}>
                {sourceLanguages.map((option) => (
                  <option key={option.value + option.label} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>目标语言</span>
              <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
                {targetLanguages.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="action-row">
            <button
              className="primary-button"
              type="button"
              onClick={() => void runAction('capture')}
              disabled={busyAction !== null}
            >
              {busyAction === 'capture'
                ? '截图识别翻译中...'
                : probe?.preferredMode === 'system-fallback'
                  ? '系统截图并翻译'
                  : '框选截图并翻译'}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void runAction('clipboard')}
              disabled={busyAction !== null}
            >
              {busyAction === 'clipboard' ? '读取剪贴板中...' : '翻译剪贴板图片'}
            </button>
          </div>
          {busyHint && <p className="busy-hint">{busyHint}</p>}

          <div className="usage-card">
            <h3>怎么用</h3>
            <ol className="usage-list">
              <li>先选原文语言和目标语言。</li>
              <li>点击“检测截图能力”，看当前会走覆盖层还是系统截图兜底。</li>
              <li>点击主按钮开始截图翻译。</li>
              <li>如果当前是 mac 打包版，默认会直接调系统截图。</li>
              <li>如果覆盖层可用，会直接进入全屏框选；否则会自动调系统截图。</li>
              <li>完成框选后，OCR 和翻译结果回到右侧。</li>
            </ol>
          </div>

          <div className="manual-card">
            <div className="manual-head">
              <h3>手动文本翻译</h3>
              <button
                className="text-button"
                type="button"
                onClick={() => void translateManualText()}
                disabled={busyAction !== null || !manualText.trim()}
              >
                {busyAction === 'manual' ? '翻译中...' : '翻译文本'}
              </button>
            </div>
            <textarea
              value={manualText}
              onChange={(event) => setManualText(event.target.value)}
              placeholder="可以粘贴文本，单独验证本地翻译是否可用。"
            />
            {manualTranslation && (
              <div className="manual-result">
                <p>{manualTranslation.text ?? '当前系统未返回可用翻译结果。'}</p>
                {manualTranslation.warning && <p className="notice-line">{manualTranslation.warning}</p>}
              </div>
            )}
          </div>

          {error && <div className="error-banner">{error}</div>}
        </div>

        <div className="panel result-panel">
          <div className="result-header">
            <div>
              <h2>识别结果</h2>
              <p className="panel-subtitle">
                当前方向：{sourceLabel} → {targetLabel}
              </p>
            </div>
          </div>

          {result ? (
            <div className="result-stack">
              <div className="shot-preview">
                <img src={result.imageDataUrl} alt="最近一次截图预览" />
              </div>

              <div className="meta-grid">
                <div className="meta-card">
                  <span>OCR 引擎</span>
                  <strong>{result.ocrProvider}</strong>
                </div>
                <div className="meta-card">
                  <span>翻译引擎</span>
                  <strong>{result.translationProvider}</strong>
                </div>
              </div>

              <div className="text-columns">
                <section className="text-card">
                  <div className="text-card-head">
                    <h3>OCR 原文</h3>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(result.recognizedText)}
                    >
                      复制
                    </button>
                  </div>
                  <pre>{result.recognizedText || '没有识别到文本。'}</pre>
                </section>

                <section className="text-card">
                  <div className="text-card-head">
                    <h3>翻译结果</h3>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(result.translatedText ?? '')}
                      disabled={!result.translatedText}
                    >
                      复制
                    </button>
                  </div>
                  <pre>{result.translatedText || '当前系统未返回翻译结果。'}</pre>
                </section>
              </div>

              {result.notices.length > 0 && (
                <div className="notice-box">
                  {result.notices.map((notice) => (
                    <p key={notice}>{notice}</p>
                  ))}
                </div>
              )}
            </div>
          ) : partialOcr ? (
            <div className="result-stack">
              <div className="shot-preview">
                <img src={partialOcr.imageDataUrl} alt="当前截图预览" />
              </div>

              <div className="meta-grid">
                <div className="meta-card">
                  <span>OCR 引擎</span>
                  <strong>{partialOcr.ocrProvider}</strong>
                </div>
                <div className="meta-card">
                  <span>翻译引擎</span>
                  <strong>Hy-MT2 1.8B GGUF</strong>
                </div>
              </div>

              <div className="text-columns">
                <section className="text-card">
                  <div className="text-card-head">
                    <h3>OCR 原文</h3>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(partialOcr.recognizedText)}
                    >
                      复制
                    </button>
                  </div>
                  <pre>{partialOcr.recognizedText || '没有识别到文本。'}</pre>
                </section>

                <section className="text-card">
                  <div className="text-card-head">
                    <h3>翻译结果</h3>
                  </div>
                  <pre>OCR 已完成，正在等待本地 Hy-MT2 模型返回翻译结果...</pre>
                </section>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <p>还没有截图结果。</p>
              <p>点击左侧“框选截图并翻译”，进入选区层后松开鼠标即可开始翻译。</p>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

function App(): React.JSX.Element {
  return window.location.hash === '#capture' ? <CaptureOverlay /> : <MainWorkspace />
}

export default App
