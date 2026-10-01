<#
  AI capability probe — one model, five checks
  --------------------------------------------
  For a given model on a relay, determines:
    1. basic connectivity          (Anthropic /v1/messages, no thinking)
    2. thinking OLD format         (thinking:{type:enabled, budget_tokens})
    3. thinking NEW format         (thinking:{type:adaptive} + output_config.effort)
    4. tool calling via OpenAI     (/v1/chat/completions, OpenAI tools schema)
    5. tool calling via Anthropic  (/v1/messages, Anthropic tools schema)

  A check "passes" when the HTTP status is 200. For tool checks it also
  reports whether the model actually emitted a tool call.

  Usage:
      $env:ZHIQU_AI_KEY = "sk-..."
      .\ai-capability-probe.ps1 -Model "claude-fable-5"
      .\ai-capability-probe.ps1 -Model "claude-opus-4-8"

  All request bodies are written WITHOUT a UTF-8 BOM (Go relays reject BOM).
#>
[CmdletBinding()]
param(
    [string]$Base  = "https://www.packyapi.com",
    [string]$Key   = $env:ZHIQU_AI_KEY,
    [string]$Model = "claude-fable-5"
)

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not $Key) {
    Write-Host "No API key. Run:  `$env:ZHIQU_AI_KEY = `"sk-...`"" -ForegroundColor Red
    exit 1
}

$Base = $Base.TrimEnd('/')
$tmp  = Join-Path $env:TEMP "zhiqu-cap"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host ""
Write-Host "Base  : $Base"
Write-Host "Model : $Model"

# --------------------------------------------------------------- helpers ----

function Write-JsonNoBom { param([string]$Path,[string]$Json)
    [IO.File]::WriteAllText($Path, $Json, (New-Object Text.UTF8Encoding $false))
}

# Runs one POST, returns @{ code=..., body=... }
function Invoke-Probe {
    param([string]$Label, [string]$Url, [string[]]$Headers, [string]$Json)

    Write-Host ""
    Write-Host ("=== {0} ===" -f $Label) -ForegroundColor Cyan
    Write-Host ("POST {0}" -f $Url) -ForegroundColor DarkGray

    $bodyFile = Join-Path $tmp 'b.json'
    $outFile  = Join-Path $tmp 'o.txt'
    Write-JsonNoBom $bodyFile $Json

    $a = @('-sS','-o',$outFile,'-w','%{http_code}','-X','POST',$Url,'--data-binary',"@$bodyFile")
    foreach ($h in $Headers) { $a += @('-H',$h) }
    $code = & curl.exe @a

    $body = ''
    if (Test-Path $outFile) { $body = [IO.File]::ReadAllText($outFile,[Text.Encoding]::UTF8) }

    $color = if ($code -eq '200') { 'Green' } elseif ($code -match '^4') { 'Red' } else { 'Yellow' }
    Write-Host ("  HTTP {0}" -f $code) -ForegroundColor $color
    $show = if ($body.Length -gt 400) { $body.Substring(0,400) + ' ...' } else { $body }
    Write-Host ("  {0}" -f $show.Trim()) -ForegroundColor DarkGray

    return @{ code = $code; body = $body }
}

$anthHeaders = @("x-api-key: $Key","anthropic-version: 2023-06-01","content-type: application/json")
$oaiHeaders  = @("Authorization: Bearer $Key","content-type: application/json")

# ---------------------------------------------------------------- probes ----

# 1. connectivity
$r1 = Invoke-Probe "1. connectivity (messages)" "$Base/v1/messages" $anthHeaders `
    ('{"model":"' + $Model + '","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}')

# 2. thinking OLD (enabled + budget_tokens)
$r2 = Invoke-Probe "2. thinking OLD (enabled+budget)" "$Base/v1/messages" $anthHeaders `
    ('{"model":"' + $Model + '","max_tokens":2048,"thinking":{"type":"enabled","budget_tokens":1024},"messages":[{"role":"user","content":"2+2? think first"}]}')

# 3. thinking NEW (adaptive + output_config.effort)
$r3 = Invoke-Probe "3. thinking NEW (adaptive+effort)" "$Base/v1/messages" $anthHeaders `
    ('{"model":"' + $Model + '","max_tokens":2048,"thinking":{"type":"adaptive"},"output_config":{"effort":"high"},"messages":[{"role":"user","content":"2+2? think first"}]}')

# 4. tools via OpenAI chat/completions
$oaiTools = '"tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"auto"'
$r4 = Invoke-Probe "4. tools OpenAI (chat/completions)" "$Base/v1/chat/completions" $oaiHeaders `
    ('{"model":"' + $Model + '","max_tokens":256,"messages":[{"role":"user","content":"What is the weather in Tokyo?"}],' + $oaiTools + '}')

# 5. tools via Anthropic messages
$anthTools = '"tools":[{"name":"get_weather","description":"Get current weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]'
$r5 = Invoke-Probe "5. tools Anthropic (messages)" "$Base/v1/messages" $anthHeaders `
    ('{"model":"' + $Model + '","max_tokens":256,"messages":[{"role":"user","content":"What is the weather in Tokyo?"}],' + $anthTools + '}')

# --------------------------------------------------------------- verdict ----

function P($code) { if ($code -eq '200') { 'PASS' } else { "FAIL($code)" } }
$toolOpenAiCalled = $r4.body -match 'tool_calls'
$toolAnthCalled   = ($r5.body -match 'tool_use')

Write-Host ""
Write-Host "================= CAPABILITY MATRIX =================" -ForegroundColor Cyan
Write-Host ("  model                     : {0}" -f $Model)
Write-Host ("  connectivity              : {0}" -f (P $r1.code))
Write-Host ("  thinking OLD (enabled)    : {0}" -f (P $r2.code))
Write-Host ("  thinking NEW (adaptive)   : {0}" -f (P $r3.code))
Write-Host ("  tools via OpenAI endpoint : {0}  (emitted tool_call: {1})" -f (P $r4.code), $toolOpenAiCalled)
Write-Host ("  tools via Anthropic endpt : {0}  (emitted tool_use : {1})" -f (P $r5.code), $toolAnthCalled)
Write-Host ""

# thinking recommendation
if ($r3.code -eq '200') {
    Write-Host "  -> THINKING: use NEW format (adaptive + output_config.effort)" -ForegroundColor Green
} elseif ($r2.code -eq '200') {
    Write-Host "  -> THINKING: use OLD format (enabled + budget_tokens)" -ForegroundColor Green
} else {
    Write-Host "  -> THINKING: neither format accepted — do not send thinking params" -ForegroundColor Yellow
}

# tools recommendation
if ($toolOpenAiCalled) {
    Write-Host "  -> TOOLS: OpenAI endpoint works. Point tool calls at /v1/chat/completions." -ForegroundColor Green
} elseif ($toolAnthCalled) {
    Write-Host "  -> TOOLS: only Anthropic tools format works. Tool calls must use /v1/messages + Anthropic schema." -ForegroundColor Yellow
} elseif ($r4.code -eq '200' -or $r5.code -eq '200') {
    Write-Host "  -> TOOLS: request accepted but model did not call the tool (may need a clearer prompt)." -ForegroundColor Yellow
} else {
    Write-Host "  -> TOOLS: neither endpoint accepted the tools request." -ForegroundColor Red
}
Write-Host ""
