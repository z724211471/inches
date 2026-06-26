type CommandFailure = {
  message?: string
  stderr?: string
  stdout?: string
  code?: string | number
}

function getErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const commandFailure = error as Error & CommandFailure
  return [commandFailure.message, commandFailure.stderr, commandFailure.stdout].filter(Boolean).join('\n')
}

export function describeMacSystemCaptureError(error: unknown): string {
  const details = getErrorDetails(error)

  if (/could not create image from rect|ENOENT|no such file or directory/i.test(details)) {
    return '系统截图没有生成图片。请重新点击“系统截图并翻译”，然后拖拽框选一个有效区域；如果刚才按了 Esc 或只点了一下，这是正常取消。'
  }

  if (/user canceled|cancelled|canceled/i.test(details)) {
    return '系统截图已取消。'
  }

  return `macOS 系统截图失败: ${details || '未知错误'}`
}
