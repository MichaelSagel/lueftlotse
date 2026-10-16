param(
 [Parameter(Mandatory=$true)][string]$ToolchainBin,
 [Parameter(Mandatory=$true)][string]$Qemu
)
$ErrorActionPreference = 'Stop'
$firmware = Split-Path $PSScriptRoot -Parent
$out = Join-Path $firmware 'build/codec-tests'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$elf = Join-Path $out 'vectors.elf'
& (Join-Path $ToolchainBin 'riscv32-esp-elf-g++.exe') -std=c++17 -O2 -Wall -Wextra -Werror -ffreestanding -fno-builtin -fno-exceptions -fno-rtti -march=rv32im -mabi=ilp32 -mno-relax -msmall-data-limit=0 -nostdlib "-I$firmware/components/ble_protocol/include" (Join-Path $firmware 'components/ble_protocol/ble_protocol.cpp') (Join-Path $PSScriptRoot 'vectors.cpp') (Join-Path $PSScriptRoot 'start.S') "-T$PSScriptRoot/link.ld" -lgcc -o $elf
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
