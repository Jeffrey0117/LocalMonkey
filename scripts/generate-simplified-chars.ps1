# Regenerate src/translate/simplified-chars.js
#
# WHY A GENERATOR: the first hand-written list of simplified characters missed
# three of the ones that were actually in the cache. A hand-written list is the
# wrong shape for this job. This script asks Windows itself (the same conversion
# table Office / Explorer use, via Microsoft.VisualBasic.Strings.StrConv) which
# CJK code points change when converted to Traditional Chinese, and writes the
# answer out as data.
#
# ASCII-only comments on purpose: PowerShell 5.1 mis-decodes UTF-8 .ps1 files
# without a BOM and eats the line after a comment containing non-ASCII text.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-simplified-chars.ps1

Add-Type -AssemblyName Microsoft.VisualBasic

$ErrorActionPreference = 'Stop'
$lcid = 2052  # zh-CN: StrConv needs a locale whose code page covers the input

# Code point ranges worth scanning. CJK Unified Ideographs + Extension A:
# everything the simplification reform touched lives in the first block, but
# Extension A is cheap to include and rules out surprises.
$ranges = @(
  @{ from = 0x3400; to = 0x4DBF },
  @{ from = 0x4E00; to = 0x9FFF }
)

$found = New-Object System.Collections.Generic.List[int]

foreach ($range in $ranges) {
  for ($code = $range.from; $code -le $range.to; $code++) {
    $char = [char]$code
    $traditional = [Microsoft.VisualBasic.Strings]::StrConv(
      [string]$char, [Microsoft.VisualBasic.VbStrConv]::TraditionalChinese, $lcid)

    # One simplified character can expand to several traditional ones, so
    # compare the whole result rather than just the first character.
    if ($traditional -ne [string]$char) { $found.Add($code) }
  }
}

if ($found.Count -lt 1500) {
  throw "only $($found.Count) code points differed - the conversion table looks unavailable, refusing to write a truncated file"
}

$out = Join-Path $PSScriptRoot '..\src\translate\simplified-chars.js'
$out = [System.IO.Path]::GetFullPath($out)

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("'use strict';")
$lines.Add('')
$lines.Add('/**')
$lines.Add(' * GENERATED FILE - do not edit by hand.')
$lines.Add(' * Regenerate with scripts/generate-simplified-chars.ps1 (see that file for why).')
$lines.Add(' *')
$lines.Add(" * Code points whose Traditional Chinese conversion differs from themselves,")
$lines.Add(" * i.e. characters that only appear in simplified text. $($found.Count) of them.")
$lines.Add(' */')
$lines.Add('')
$lines.Add('/** @type {ReadonlyArray<number>} */')
$lines.Add('const SIMPLIFIED_CODE_POINTS = Object.freeze([')

# 16 per line keeps the file diffable and under any sane line-length limit.
for ($i = 0; $i -lt $found.Count; $i += 16) {
  $slice = $found.GetRange($i, [Math]::Min(16, $found.Count - $i))
  $hex = ($slice | ForEach-Object { '0x{0:x4}' -f $_ }) -join ', '
  $lines.Add("  $hex,")
}

$lines.Add(']);')
$lines.Add('')
$lines.Add('module.exports = { SIMPLIFIED_CODE_POINTS };')

[System.IO.File]::WriteAllLines($out, $lines, (New-Object System.Text.UTF8Encoding $false))

Write-Output "wrote $($found.Count) code points to $out"
