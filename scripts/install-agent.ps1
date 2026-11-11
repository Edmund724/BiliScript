[CmdletBinding()]
param(
    [string]$SourceDir = "",
    [string]$SkillRoot = (Join-Path $HOME ".agents/skills")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Test-ProxyEndpoint([string]$Proxy) {
    try {
        $uri = [Uri]$Proxy
        if (-not $uri.Host -or $uri.Port -le 0) { return $false }
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $connected = $client.ConnectAsync($uri.Host, $uri.Port).Wait(1000)
            return $connected -and $client.Connected
        } catch {
            return $false
        } finally {
            $client.Dispose()
        }
    } catch {
        return $false
    }
}

function Repair-SessionProxy {
    $names = @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")
    $broken = @()
    foreach ($name in $names) {
        $value = [Environment]::GetEnvironmentVariable($name, "Process")
        if ($value -and -not (Test-ProxyEndpoint $value)) {
            $broken += $name
        }
    }
    if ($broken.Count -eq 0) { return }

    $replacement = ""
    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($git) {
        $candidate = (& $git.Source config --global --get http.proxy 2>$null | Select-Object -First 1)
        if ($candidate -and (Test-ProxyEndpoint $candidate)) {
            $replacement = $candidate
        }
    }
    if (-not $replacement) {
        foreach ($name in $names) {
            $value = [Environment]::GetEnvironmentVariable($name, "Process")
            if ($value -and $name -notin $broken -and (Test-ProxyEndpoint $value)) {
                $replacement = $value
                break
            }
        }
    }

    foreach ($name in $broken) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    if ($replacement) {
        [Environment]::SetEnvironmentVariable("HTTP_PROXY", $replacement, "Process")
        [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $replacement, "Process")
        Write-Host "已改用可用的 Git 代理配置（仅当前安装进程）。"
    } else {
        Write-Host "已绕开失效的会话代理（$($broken -join ", ")），尝试直连（仅当前安装进程）。"
    }
}

function Save-RemoteFile([string]$Uri, [string]$Destination) {
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -TimeoutSec 60
}

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    throw "未检测到 Node.js。请先安装 Node.js 22.20 或更高版本，再重新运行此命令。"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("biliscript-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {
    $staging = Join-Path $temp "biliscript"
    if ($SourceDir) {
        $source = (Resolve-Path $SourceDir).Path
        if (-not (Test-Path (Join-Path $source "SKILL.md")) -or -not (Test-Path (Join-Path $source "scripts/biliscript.mjs"))) {
            throw "SourceDir 不是有效的 BiliScript Skill 目录：$source"
        }
        Copy-Item -Path $source -Destination $staging -Recurse
    } else {
        Repair-SessionProxy
        try {
            $archive = Join-Path $temp "biliscript.zip"
            Save-RemoteFile "https://codeload.github.com/Edmund724/BiliScript/zip/refs/heads/main" $archive
            $extract = Join-Path $temp "archive"
            Expand-Archive -Path $archive -DestinationPath $extract
            $repository = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
            if (-not $repository) { throw "GitHub ZIP 中未找到仓库目录" }
            $source = Join-Path $repository.FullName "skills/biliscript"
            Copy-Item -Path $source -Destination $staging -Recurse
        } catch {
            Write-Host "GitHub ZIP 安装失败：$($_.Exception.Message)"
            Write-Host "正在改用 jsDelivr 下载 Skill 与 CLI…"
            New-Item -ItemType Directory -Path (Join-Path $staging "scripts") -Force | Out-Null
            Save-RemoteFile "https://cdn.jsdelivr.net/gh/Edmund724/BiliScript@main/skills/biliscript/SKILL.md" (Join-Path $staging "SKILL.md")
            Save-RemoteFile "https://cdn.jsdelivr.net/gh/Edmund724/BiliScript@main/skills/biliscript/scripts/biliscript.mjs" (Join-Path $staging "scripts/biliscript.mjs")
        }
    }

    $targetRoot = [IO.Path]::GetFullPath($SkillRoot)
    $target = Join-Path $targetRoot "biliscript"
    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
    $backup = Join-Path $temp "previous-skill"
    $hasBackup = Test-Path $target
    if ($hasBackup) {
        Move-Item -Path $target -Destination $backup
    }
    try {
        Move-Item -Path $staging -Destination $target
    } catch {
        if ($hasBackup -and (Test-Path $backup)) {
            Move-Item -Path $backup -Destination $target
        }
        throw
    }

    $cli = Join-Path $target "scripts/biliscript.mjs"
    Write-Host "BiliScript Skill 与 CLI 已安装到：$target"
    Write-Host "正在启动本地 Bridge 并检查扩展连接…"
    $statusText = (& $node.Source $cli status 2>&1 | Out-String).Trim()
    $statusExitCode = $LASTEXITCODE
    Write-Output $statusText
    if ($statusExitCode -ne 0) {
        throw "CLI status 失败（退出码 $statusExitCode）：$statusText"
    }
    try {
        $status = $statusText | ConvertFrom-Json
    } catch {
        throw "CLI status 返回了无效 JSON：$statusText"
    }
    if ($status.extensionOnline -eq $true) {
        Write-Host "本地 Agent 已就绪，扩展连接正常。"
    } else {
        Write-Host "Bridge 已启动。请回到 BiliScript 扩展的「设置 → 本地 Agent」，点击「去连接」。"
    }
} catch {
    Write-Host "BiliScript 本地 Agent 安装失败：$($_.Exception.Message)"
    throw
} finally {
    Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
