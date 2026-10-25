param(
 [Parameter(Mandatory=$true)][string]$ToolchainBin,
 [Parameter(Mandatory=$true)][string]$Qemu
)
$ErrorActionPreference = 'Stop'
$firmware = Split-Path $PSScriptRoot -Parent
$out = Join-Path $firmware 'build/codec-tests'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$elf = Join-Path $out 'vectors.elf'
# Compile the same literal JSON fixtures imported by the TypeScript tests.
# Generate only C++ initializers, never expected bytes or checksums here.
$fixtures = Get-Content -Raw -Encoding utf8 (Join-Path $firmware '../docs/test-vectors/ble-live-sample-v1.1.json') | ConvertFrom-Json
$header = @('const InfoVector shared_info_vectors[] = {')
foreach ($v in $fixtures.infoVectors) {
 $header += '{{ {0}, {1}, "{2}" }},' -f $v.minor, $v.capabilities, $v.hex
}
$header += '};', 'const LiveSampleVector shared_live_vectors[] = {'
foreach ($v in $fixtures.liveSampleVectors) {
 $header += '{{ "{0}", {1}ULL, {2}ULL, {3}, {4}, "{5}", "{6}", {{ "{7}", "{8}", "{9}" }} }},' -f $v.bootId.Replace('-', ''), $v.sampleCounter, $v.uptimeMs, $v.ppm, $v.messageId, $v.body, $v.logical, $v.frames[0], $v.frames[1], $v.frames[2]
}
$header += '};'
$header | Set-Content -Encoding ascii (Join-Path $out 'shared-live-vectors.hpp')
& (Join-Path $ToolchainBin 'riscv32-esp-elf-g++.exe') -std=c++17 -O2 -Wall -Wextra -Werror -ffreestanding -fno-builtin -fno-exceptions -fno-rtti -march=rv32im -mabi=ilp32 -mno-relax -msmall-data-limit=0 -nostdlib "-I$firmware/components/ble_protocol/include" "-I$out" (Join-Path $firmware 'components/ble_protocol/ble_protocol.cpp') (Join-Path $PSScriptRoot 'vectors.cpp') (Join-Path $PSScriptRoot 'start.S') "-T$PSScriptRoot/link.ld" -lgcc -o $elf
if ($LASTEXITCODE -ne 0) { throw 'Vector test compilation failed' }
$process = New-Object System.Diagnostics.Process
$process.StartInfo.FileName = $Qemu
$process.StartInfo.Arguments = '-machine virt -bios none -nographic -kernel "' + $elf + '"'
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.CreateNoWindow = $true
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
try {
 $process.Start() | Out-Null
 $stdout = $process.StandardOutput.ReadToEndAsync()
 $stderr = $process.StandardError.ReadToEndAsync()
 if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Vector tests timed out' }
 Write-Output $stdout.Result
 Write-Output $stderr.Result
 if ($process.ExitCode -ne 0) { throw "Vector tests failed: $($process.ExitCode)" }
} finally { $process.Dispose() }
