[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath,

  [Parameter(Mandatory = $false)]
  [string]$Language = "en-US"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]

function Await {
  param(
    [Parameter(Mandatory = $true)]
    $Operation,

    [Parameter(Mandatory = $true)]
    [Type]$ResultType
  )

  $task = [System.WindowsRuntimeSystemExtensions]::AsTask($Operation)
  $task.Wait()
  return $task.Result
}

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $languageObject = $null
  try {
    $languageObject = [Windows.Globalization.Language]::new($Language)
  } catch {
    $languageObject = $null
  }

  $engine = $null
  if ($languageObject) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languageObject)
  }

  if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }

  if (-not $engine) {
    throw "Windows 本地 OCR 引擎不可用。"
  }

  $ocrResult = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $ocrResult.Lines) {
    if ($line.Text) {
      $lines += $line.Text
    }
  }

  @{
    provider = "Windows Media OCR"
    text = ($lines -join "`n")
    error = $null
  } | ConvertTo-Json -Compress
} catch {
  @{
    provider = "Windows Media OCR"
    text = ""
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 1
}
