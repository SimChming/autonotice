# ============================================================
# sync-docs.ps1 — HANDOFF.md / requirements.txt / CONFIGURATION.md 双向同步
# 本机(default/) <-> 服务器(/opt/qqsched/src/)
# 规则：内容不同时，mtime 新的覆盖旧的；相同则跳过
# 依赖：本机公钥已装入服务器 root 的 authorized_keys（免密 SSH）
# ============================================================
$ErrorActionPreference = 'Stop'

$Host1 = 'root@120.26.224.86'
$RemoteDir = '/opt/qqsched/src'
$LocalRoot = 'C:\Users\Surface\Documents\Trae-CN\default'
$Files = @('HANDOFF.md', 'requirements.txt', 'CONFIGURATION.md')

$sshOpts = @('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=20')

function Get-RemoteMeta([string]$file) {
    # 返回 "md5|epoch"
    $out = ssh @sshOpts $Host1 "md5sum '$RemoteDir/$file' 2>/dev/null | cut -d' ' -f1; stat -c %Y '$RemoteDir/$file' 2>/dev/null" 2>$null
    if (-not $out -or $out.Count -lt 2) { return $null }
    return @{ md5 = "$($out[0])".Trim(); mtime = [long]"$($out[1])".Trim() }
}

foreach ($f in $Files) {
    $local = Join-Path $LocalRoot $f
    if (-not (Test-Path $local)) { Write-Host "[skip] 本地不存在: $f"; continue }

    $localMd5 = (Get-FileHash $local -Algorithm MD5).Hash.ToLower()
    $localMtime = [long]((Get-Item $local).LastWriteTimeUtc - [datetime]'1970-01-01').TotalSeconds

    $remote = Get-RemoteMeta $f
    if ($null -eq $remote) {
        Write-Host "[push] 远端缺失，上传 $f"
        scp @sshOpts $local "${Host1}:${RemoteDir}/$f" | Out-Null
        continue
    }
    if ($remote.md5 -eq $localMd5) {
        Write-Host "[ok] 一致: $f"
        continue
    }
    if ($localMtime -ge $remote.mtime) {
        Write-Host "[push] 本地较新，上传 $f"
        scp @sshOpts $local "${Host1}:${RemoteDir}/$f" | Out-Null
    } else {
        Write-Host "[pull] 远端较新，下载 $f"
        scp @sshOpts "${Host1}:${RemoteDir}/$f" $local | Out-Null
    }
}
Write-Host 'sync done.'
