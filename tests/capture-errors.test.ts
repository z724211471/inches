import assert from 'node:assert/strict'
import { describeMacSystemCaptureError } from '../src/main/capture-errors.ts'

const rectError = Object.assign(
  new Error(
    'Command failed: screencapture -i -x /var/folders/example/system-capture.png could not create image from rect'
  ),
  {
    stderr: 'could not create image from rect'
  }
)

const rectMessage = describeMacSystemCaptureError(rectError)
assert.match(rectMessage, /系统截图没有生成图片/)
assert.match(rectMessage, /有效区域/)
assert.doesNotMatch(rectMessage, /Command failed/)

const missingFileMessage = describeMacSystemCaptureError(
  Object.assign(new Error("ENOENT: no such file or directory, open '/var/folders/example/system-capture.png'"), {
    code: 'ENOENT'
  })
)
assert.match(missingFileMessage, /系统截图没有生成图片/)
assert.doesNotMatch(missingFileMessage, /ENOENT/)

const canceledMessage = describeMacSystemCaptureError(new Error('user canceled'))
assert.equal(canceledMessage, '系统截图已取消。')

const unknownMessage = describeMacSystemCaptureError(new Error('permission denied'))
assert.equal(unknownMessage, 'macOS 系统截图失败: permission denied')

console.log('capture-errors.test.ts passed')
