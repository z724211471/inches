import assert from 'node:assert/strict'
import { buildTranslateRequestFromCapture } from '../src/main/translation-request.ts'

const request = buildTranslateRequestFromCapture('Hello', {
  sourceLanguage: 'en-US',
  targetLanguage: 'zh-Hans',
  translationProvider: 'deepseek',
  onlineModel: 'deepseek-chat',
  onlineApiKey: 'sk-test'
})

assert.deepEqual(request, {
  text: 'Hello',
  sourceLanguage: 'en-US',
  targetLanguage: 'zh-Hans',
  translationProvider: 'deepseek',
  onlineModel: 'deepseek-chat',
  onlineApiKey: 'sk-test'
})

console.log('translation-request.test.ts passed')
