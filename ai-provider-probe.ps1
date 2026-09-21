<#
  AI provider connectivity probe
  ------------------------------
  Tries every request shape your backend supports against one relay endpoint,
  so you can tell which adapter / providerType actually works.

  Usage:
      $env:ZHIQU_AI_KEY = "sk-..."
      .\ai-provider-probe.ps1 -Base "https://www.packyapi.com" -Model "claude-fable-5"

  Notes:
    - All request bodies are written WITHOUT a UTF-8 BOM. Windows PowerShell 5.1
      Set-Content -Encoding utf8 emits a BOM, which Go-based relays reject with
      "invalid character 'i' looking for beginning of value".
    - Never pass the key as a literal argument; use the env var above so it does
      not land in PSReadLine history.
#>
[CmdletBinding()]
param(
    [string]$Base  = "https://www.packyapi.com",
    [string]$Key   = $env:ZHIQU_AI_KEY,
    [string]$Model = "claude-fable-5"
)

if (-not $Key) {
    Write-Host "No API key found." -ForegroundColor Red
    Write-Host 'Set it first:   $env:ZHIQU_AI_KEY = "sk-..."'
    exit 1
}

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Base = $Base.TrimEnd('/')
$tmp  = Join-Path $env:TEMP "zhiqu-probe"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$maskedKey = $Key.Substring(0, [Math]::Min(6, $Key.Length)) + "..." +
             $Key.Substring([Math]::Max(0, $Key.Length - 4))

Write-Host ""
Write-Host "Base  : $Base"
Write-Host "Model : $Model"
Write-Host "Key   : $maskedKey"

# ---------------------------------------------------------------- helpers ----

function Write-JsonNoBom {
    param([string]$Path, [string]$Json)
    [IO.File]::WriteAllText($Path, $Json, (New-Object Text.UTF8Encoding $false))
}

function Show-Body {
    param([string]$Code, [string]$BodyFile)

    # Read as explicit UTF-8. Get-Content -Raw uses the ANSI codepage on
    # Windows PowerShell 5.1, which turns Chinese error text into mojibake
    # (e.g. the relay's "访问被拒绝" showed up as "璁块棶琚嫆缁?").
    $body = ''
    if (Test-Path $BodyFile) {
        $body = [IO.File]::ReadAllText($BodyFile, [Text.Encoding]::UTF8)
    }
    if ($null -eq $body) { $body = '' }
    if ($body.Length -gt 700) { $body = $body.Substring(0, 700) + ' ...(truncated)' }

    $color = 'Yellow'
    if ($Code -eq '200') { $color = 'Green' }
    if ($Code -match '^(401|403)$') { $color = 'Red' }

    Write-Host ("  HTTP {0}" -f $Code) -ForegroundColor $color
    Write-Host ("  {0}" -f $body.Trim()) -ForegroundColor DarkGray
}

function Probe-Get {
    param([string]$Label, [string]$Url, [string[]]$Headers)

    Write-Host ""
    Write-Host ("=== {0} ===" -f $Label) -ForegroundColor Cyan
    Write-Host ("GET  {0}" -f $Url) -ForegroundColor DarkGray

    $out = Join-Path $tmp 'out.txt'
    $a = @('-sS', '-o', $out, '-w', '%{http_code}', '-X', 'GET', $Url)
    foreach ($h in $Headers) { $a += @('-H', $h) }

    $code = & curl.exe @a
    Show-Body $code $out
    return $code
}

function Probe-Post {
    param([string]$Label, [string]$Url, [string[]]$Headers, [string]$Json)

    Write-Host ""
    Write-Host ("=== {0} ===" -f $Label) -ForegroundColor Cyan
    Write-Host ("POST {0}" -f $Url) -ForegroundColor DarkGray

    $bodyFile = Join-Path $tmp 'body.json'
    $out      = Join-Path $tmp 'out.txt'
    Write-JsonNoBom $bodyFile $Json

    $a = @('-sS', '-o', $out, '-w', '%{http_code}', '-X', 'POST', $Url,
           '--data-binary', "@$bodyFile")
    foreach ($h in $Headers) { $a += @('-H', $h) }

    $code = & curl.exe @a
    Show-Body $code $out
    return $code
}

# ----------------------------------------------------------------- probes ----

$anthropicBody = '{"model":"' + $Model + '","max_tokens":16,' +
                 '"messages":[{"role":"user","content":"hi"}]}'

$openaiBody    = '{"model":"' + $Model + '","max_tokens":16,' +
                 '"messages":[{"role":"user","content":"hi"}]}'

# 0. What models does this relay actually expose?
$codeModels = Probe-Get "0. List models (OpenAI style)" `
    "$Base/v1/models" `
    @("Authorization: Bearer $Key")

# 1. Anthropic native - this is what AnthropicMessagesAdapter sends.
$codeAnthropic = Probe-Post "1. Anthropic /v1/messages  (x-api-key)" `
    "$Base/v1/messages" `
    @("x-api-key: $Key",
      "anthropic-version: 2023-06-01",
      "content-type: application/json") `
    $anthropicBody

# 2. Same endpoint, bearer auth - some relays only accept Bearer.
$codeAnthropicBearer = Probe-Post "2. Anthropic /v1/messages  (Bearer)" `
    "$Base/v1/messages" `
    @("Authorization: Bearer $Key",
      "anthropic-version: 2023-06-01",
      "content-type: application/json") `
    $anthropicBody

# 3. OpenAI compatible - what OpenAiChatCompatibleAdapter sends.
$codeOpenAi = Probe-Post "3. OpenAI /v1/chat/completions  (Bearer)" `
    "$Base/v1/chat/completions" `
    @("Authorization: Bearer $Key",
      "content-type: application/json") `
    $openaiBody

# ---------------------------------------------------------------- verdict ----

Write-Host ""
Write-Host "================ SUMMARY ================" -ForegroundColor Cyan
Write-Host ("  models              : HTTP {0}" -f $codeModels)
Write-Host ("  messages x-api-key  : HTTP {0}" -f $codeAnthropic)
Write-Host ("  messages Bearer     : HTTP {0}" -f $codeAnthropicBearer)
Write-Host ("  chat/completions    : HTTP {0}" -f $codeOpenAi)
Write-Host ""

$ok = @()
if ($codeAnthropic       -eq '200') { $ok += "providerType=ANTHROPIC,  apiUrl=$Base/v1/messages" }
if ($codeAnthropicBearer -eq '200') { $ok += "providerType=ANTHROPIC (needs Bearer auth - adapter change required)" }
if ($codeOpenAi          -eq '200') { $ok += "providerType=OPENAI_COMPATIBLE,  apiUrl=$Base/v1/chat/completions" }

if ($ok.Count -gt 0) {
    Write-Host "WORKING CONFIGURATION(S):" -ForegroundColor Green
    foreach ($line in $ok) { Write-Host ("  -> {0}" -f $line) -ForegroundColor Green }
    Write-Host ""
    Write-Host "Set this in the model form, and make sure providerType is chosen"
    Write-Host "EXPLICITLY - inferProviderType() only matches 'anthropic.com' in"
    Write-Host "the URL, so a relay domain silently falls back to OPENAI_COMPATIBLE."
} else {
    Write-Host "NOTHING RETURNED 200." -ForegroundColor Red
    Write-Host "Read the bodies above:"
    Write-Host "  - 'only accessible via the official Claude CLI' -> the key is bound to"
    Write-Host "    Claude Code subscription quota, not the plain API. Ask the reseller"
    Write-Host "    for an API-type key; no client-side change can fix this one."
    Write-Host "  - 'model not found' / 'no available channel' -> auth is fine, the model"
    Write-Host "    id is wrong. Use a name from probe 0 above."
    Write-Host "  - 401 -> the key itself is wrong or expired."
}
Write-Host ""
