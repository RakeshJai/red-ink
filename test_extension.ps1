# RedInk Extension Verification Script
# Adheres to ponytail principles: minimal, native PowerShell, clear.

$BaseDir = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$script:Failed = $false
$script:Results = @()

function Add-Result {
    param(
        [string]$CheckName,
        [bool]$Passed,
        [string]$Detail
    )
    $script:Results += [PSCustomObject]@{
        Check  = $CheckName
        Status = if ($Passed) { "PASS" } else { "FAIL" }
        Detail = $Detail
    }
    if (-not $Passed) {
        $script:Failed = $true
    }
}

# 1. Verify existence of required 12 files (manifest, scripts, pages, styles, 3 icons)
$RequiredFiles = @(
    "manifest.json",
    "background.js",
    "offscreen.html",
    "offscreen.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "content.js",
    "content.css",
    "icon16.png",
    "icon48.png",
    "icon128.png"
)

foreach ($file in $RequiredFiles) {
    $path = Join-Path $BaseDir $file
    if (Test-Path $path) {
        Add-Result "File Existence - $file" $true "Found at $path"
    } else {
        Add-Result "File Existence - $file" $false "Missing at $path"
    }
}

# 2. Validate manifest.json structure and required MV3 settings
$manifestPath = Join-Path $BaseDir "manifest.json"
if (Test-Path $manifestPath) {
    try {
        $manifestContent = Get-Content $manifestPath -Raw
        $manifest = ConvertFrom-Json $manifestContent
        Add-Result "Manifest - Valid JSON" $true "Parsed successfully"

        # MV3 check
        if ($manifest.manifest_version -eq 3) {
            Add-Result "Manifest - MV3" $true "manifest_version is 3"
        } else {
            Add-Result "Manifest - MV3" $false "manifest_version is $($manifest.manifest_version), expected 3"
        }

        # Permissions check
        $requiredPermissions = @("storage", "offscreen", "tabCapture", "activeTab")
        $missingPermissions = @()
        foreach ($p in $requiredPermissions) {
            if ($manifest.permissions -notcontains $p) {
                $missingPermissions += $p
            }
        }
        if ($missingPermissions.Count -eq 0) {
            Add-Result "Manifest - Permissions" $true "Contains storage, offscreen, tabCapture, activeTab"
        } else {
            Add-Result "Manifest - Permissions" $false "Missing permissions: $($missingPermissions -join ', ')"
        }

        # Host Permissions check
        $requiredHostPermissions = @("https://api.featherless.ai/*", "https://api.deepgram.com/*")
        $missingHost = @()
        foreach ($hp in $requiredHostPermissions) {
            if ($manifest.host_permissions -notcontains $hp) {
                $missingHost += $hp
            }
        }
        if ($missingHost.Count -eq 0) {
            Add-Result "Manifest - Host Permissions" $true "Contains required host permissions"
        } else {
            Add-Result "Manifest - Host Permissions" $false "Missing host permissions: $($missingHost -join ', ')"
        }

        # Background worker type module check
        if ($manifest.background -and $manifest.background.service_worker -eq "background.js" -and $manifest.background.type -eq "module") {
            Add-Result "Manifest - Background Worker" $true "background.service_worker is background.js and type is module"
        } else {
            $type = if ($manifest.background) { $manifest.background.type } else { "null" }
            $sw = if ($manifest.background) { $manifest.background.service_worker } else { "null" }
            Add-Result "Manifest - Background Worker" $false "Expected background.service_worker='background.js' and type='module'. Found service_worker='$sw', type='$type'"
        }

        # content.css location checks: web_accessible_resources but NOT content_scripts
        $cssInAccessible = $false
        if ($manifest.web_accessible_resources) {
            foreach ($res in $manifest.web_accessible_resources) {
                if ($res.resources -contains "content.css") {
                    $cssInAccessible = $true
                }
            }
        }

        $cssInScripts = $false
        if ($manifest.content_scripts) {
            foreach ($cs in $manifest.content_scripts) {
                if ($cs.css -and $cs.css -contains "content.css") {
                    $cssInScripts = $true
                }
            }
        }

        if ($cssInAccessible -and -not $cssInScripts) {
            Add-Result "Manifest - content.css location" $true "content.css is in web_accessible_resources and NOT in content_scripts"
        } else {
            Add-Result "Manifest - content.css location" $false "Expected content.css in web_accessible_resources but NOT in content_scripts. In resources: $cssInAccessible, In scripts: $cssInScripts"
        }
    } catch {
        Add-Result "Manifest - Valid JSON" $false "JSON Parsing failed: $_"
    }
} else {
    Add-Result "Manifest - Valid JSON" $false "manifest.json does not exist, skipping detailed checks"
}

# 3. Scan background.js checks
$backgroundPath = Join-Path $BaseDir "background.js"
if (Test-Path $backgroundPath) {
    $bgContent = Get-Content $backgroundPath -Raw
    
    # 3.1 Targets https://api.featherless.ai/v1/chat/completions
    if ($bgContent -match "https://api\.featherless\.ai/v1/chat/completions") {
        Add-Result "background.js - Featherless API URL" $true "Targets correct Featherless completions API endpoint"
    } else {
        Add-Result "background.js - Featherless API URL" $false "Missing Featherless API endpoint reference"
    }

    # 3.2 clientsList = await clients.matchAll
    if ($bgContent -match "clientsList\s*=\s*await\s+clients\.matchAll") {
        Add-Result "background.js - Temporal Dead Zone Fix" $true "Contains clientsList = await clients.matchAll"
    } else {
        Add-Result "background.js - Temporal Dead Zone Fix" $false "Missing 'clientsList = await clients.matchAll' fix"
    }

    # 3.3 Validates incoming transcription payloads
    if ($bgContent -match "(!text\s*\|\|\s*!text\.trim\(\))") {
        Add-Result "background.js - Transcription Payload Validation" $true "Validates/ignores empty transcription payloads using trim()"
    } else {
        Add-Result "background.js - Transcription Payload Validation" $false "Missing empty/whitespace validation on transcription payload"
    }

    # 3.4 Safely checks findings array formatting
    if ($bgContent -match "Array\.isArray\(\s*findings\s*\)") {
        Add-Result "background.js - Array Check" $true "Validates that findings is an array using Array.isArray(findings)"
    } else {
        Add-Result "background.js - Array Check" $false "Missing Array.isArray(findings) validation check"
    }
} else {
    Add-Result "background.js" $false "background.js does not exist"
}

# 4. Scan offscreen.js checks
$offscreenPath = Join-Path $BaseDir "offscreen.js"
if (Test-Path $offscreenPath) {
    $osContent = Get-Content $offscreenPath -Raw

    # 4.1 Streams to Deepgram WebSocket
    if ($osContent -match "wss://api\.deepgram\.com") {
        Add-Result "offscreen.js - Deepgram WebSocket" $true "Streams to Deepgram WebSocket API"
    } else {
        Add-Result "offscreen.js - Deepgram WebSocket" $false "Missing Deepgram WebSocket connection"
    }

    # 4.2 captureError communication on websocket closure
    if ($osContent -match "captureError" -and ($osContent -match "socket\.onclose" -or $osContent -match "wsUrl" -or $osContent -match "WebSocket")) {
        Add-Result "offscreen.js - captureError propagation" $true "Contains captureError message communication on unexpected closure"
    } else {
        Add-Result "offscreen.js - captureError propagation" $false "Missing captureError message on websocket closure"
    }
} else {
    Add-Result "offscreen.js" $false "offscreen.js does not exist"
}

# 5. Scan content.js checks
$contentPath = Join-Path $BaseDir "content.js"
if (Test-Path $contentPath) {
    $ctContent = Get-Content $contentPath -Raw

    # 5.1 Attaches a Shadow DOM
    if ($ctContent -match "attachShadow") {
        Add-Result "content.js - Shadow DOM" $true "Attaches a Shadow DOM to isolate styles"
    } else {
        Add-Result "content.js - Shadow DOM" $false "Missing attachShadow call"
    }

    # 5.2 Uses claimText/explanationText variables instead of direct .trim()
    if ($ctContent -match "claimText" -and $ctContent -match "explanationText") {
        Add-Result "content.js - Robust Text Variables" $true "Uses claimText and explanationText variables"
    } else {
        Add-Result "content.js - Robust Text Variables" $false "Missing claimText or explanationText variables"
    }
} else {
    Add-Result "content.js" $false "content.js does not exist"
}

# 6. Verify file count does not exceed 12 files (excluding non-extension files like ps1, md, git files)
$flatFiles = Get-ChildItem -Path $BaseDir -File | Where-Object { 
    $_.Extension -ne ".ps1" -and 
    $_.Extension -ne ".md" -and 
    $_.Name -notlike ".git*"
}
$fileCount = $flatFiles.Count
if ($fileCount -le 12) {
    Add-Result "Integrity - Directory File Count" $true "Total files in flat directory is $fileCount (<= 12)"
} else {
    Add-Result "Integrity - Directory File Count" $false "Total files in flat directory is $fileCount (> 12). Files: $($flatFiles.Name -join ', ')"
}

# 7. Print clean, formatted report and exit
Write-Host ""
Write-Host "=========================================================="
Write-Host " REDINK EXTENSION VERIFICATION REPORT"
Write-Host "=========================================================="
Write-Host ""

foreach ($r in $script:Results) {
    $color = if ($r.Status -eq "PASS") { "Green" } else { "Red" }
    Write-Host ("[{0}] {1}" -f $r.Status, $r.Check) -ForegroundColor $color
    Write-Host "      Detail: $($r.Detail)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=========================================================="
if ($script:Failed) {
    Write-Host " VERIFICATION FAILED" -ForegroundColor Red
    Write-Host "=========================================================="
    exit 1
} else {
    Write-Host " ALL CHECKS PASSED SUCCESSFULLY" -ForegroundColor Green
    Write-Host "=========================================================="
    exit 0
}
