export type TranslationProviderId = 'hy-mt-local' | 'openai' | 'deepseek' | 'gemini'

export type CaptureTranslationOptions = {
  sourceLanguage: string
  targetLanguage: string
  translationProvider?: TranslationProviderId
  onlineModel?: string
  onlineApiKey?: string
}

export type TranslateRequestPayload = CaptureTranslationOptions & {
  text: string
}

export function buildTranslateRequestFromCapture(
  text: string,
  request: CaptureTranslationOptions
): TranslateRequestPayload {
  return {
    text,
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    translationProvider: request.translationProvider,
    onlineModel: request.onlineModel,
    onlineApiKey: request.onlineApiKey
  }
}
