$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$frontendRoot = Split-Path $PSScriptRoot -Parent
$aapt = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/aapt2.exe'
foreach ($variant in @('debug', 'release')) {
    $name = if ($variant -eq 'debug') { 'app-debug.apk' } else { 'app-release-unsigned.apk' }
    $apk = Join-Path $frontendRoot "android/app/build/outputs/apk/$variant/$name"
    $zip = [IO.Compression.ZipFile]::OpenRead($apk)
    try {
        $profileEntry = $zip.GetEntry('assets/public/build-profile.json')
        if (-not $profileEntry) { throw 'Missing profile marker' }
        $reader = [IO.StreamReader]::new($profileEntry.Open())
        try { $profile = ($reader.ReadToEnd() | ConvertFrom-Json).profile } finally { $reader.Dispose() }
        $expected = if ($variant -eq 'debug') { 'usb-debug' } else { 'release' }
        if ($profile -ne $expected) { throw 'Wrong APK web profile' }
        $hasAddress = $false
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -match '^assets/public/.*\.(js|json|html)$') {
                $reader = [IO.StreamReader]::new($entry.Open())
                try { if ($reader.ReadToEnd().Contains('http://127.0.0.1:5045/api')) { $hasAddress = $true } } finally { $reader.Dispose() }
            }
        }
        if ($hasAddress -ne ($variant -eq 'debug')) { throw 'Unexpected USB address in APK' }
        if ($variant -eq 'release' -and $zip.GetEntry('res/xml/usb_debug_network_security.xml')) { throw 'Debug network resource leaked into release' }
    } finally { $zip.Dispose() }
    $manifest = (& $aapt dump xmltree $apk --file AndroidManifest.xml) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect APK manifest' }
    if ($manifest -notmatch 'usesCleartextTraffic.*(false|0x0\b)') { throw 'Missing default cleartext prohibition' }
    if (($manifest -match 'networkSecurityConfig') -ne ($variant -eq 'debug')) { throw 'Unexpected network security configuration' }
    Write-Output "Verified $variant APK profile, address and network policy."
}
