<#
  一条命令验证整条零成本链路是否真的通了。

  用法（在 free-llm-bridge 目录下）：
    powershell -ExecutionPolicy Bypass -File scripts\verify-deployment.ps1 `
      -BridgeIP <你电脑的局域网IP> -HindsightURL http://<NAS的IP>:8888

  检查三件事：
    1. 桥从局域网 IP 能不能访问到（NAS 容器用的就是这个地址）
    2. 走桥发一次真实补全（不花钱，走免费车道）
    3. Hindsight 最近的 LLM 调用用的是哪个模型 —— 必须全是 *-free 的

  兼容 Windows PowerShell 5.1（不用三元运算符等 PS7 语法）。
#>

param(
  [string]$BridgeIP = "192.168.31.21",
  [string]$HindsightURL = "http://192.168.31.123:8888",
  [string]$Bank = "coding-agent::default-workspace",
  [int]$Limit = 10
)

$ErrorActionPreference = "Stop"
$script:fails = 0

function Check($name, $ok, $detail) {
  if ($ok) {
    $mark = "PASS"
  } else {
    $mark = "FAIL"
    $script:fails++
  }
  $line = "  $mark  $name"
  if ($detail) { $line = $line + "  --  " + $detail }
  Write-Output $line
}

Write-Output ""
Write-Output "=== 1. 桥从局域网入口可达 ==="
try {
  $h = Invoke-RestMethod -Uri ("http://" + $BridgeIP + ":18999/health") -TimeoutSec 8
  $laneNames = ($h.lanes | ForEach-Object { $_.name }) -join ", "
  Check "/health 200" $true ("lanes: " + $laneNames)
} catch {
  Check "/health 200" $false $_.Exception.Message
  Write-Output "  提示：桥没起？或没绑 0.0.0.0？双击项目里的 启动桥.cmd"
}

Write-Output ""
Write-Output "=== 2. 走桥发一次真实补全 ==="
try {
  $bodyObj = @{
    model = "space-bunny-free"
    messages = @(@{ role = "user"; content = "Reply with exactly: VERIFY_OK" })
    max_tokens = 256
  }
  $body = $bodyObj | ConvertTo-Json -Depth 5 -Compress
  $r = Invoke-RestMethod -Uri ("http://" + $BridgeIP + ":18999/v1/chat/completions") -Method Post `
    -ContentType "application/json" -Headers @{ authorization = "Bearer local" } `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 150
  $content = ($r.choices[0].message.content -replace "\s+", " ")
  Check "补全返回 200" ($content.Trim().Length -gt 0) ("model=" + $r.model + " content=" + $content)
  Check "落在免费档" ($r.model -like "*-free") $r.model
} catch {
  Check "补全返回 200" $false $_.Exception.Message
}

Write-Output ""
Write-Output "=== 3. Hindsight 最近的调用是不是全免费 ==="
try {
  $uri = $HindsightURL + "/v1/default/banks/" + $Bank + "/llm-requests?limit=" + $Limit
  $resp = Invoke-RestMethod -Uri $uri -TimeoutSec 20
  if ($resp.requests) {
    $rows = $resp.requests
  } elseif ($resp.items) {
    $rows = $resp.items
  } else {
    $rows = @($resp)
  }
  $rows = @($rows | Select-Object -First $Limit)
  $paid = @($rows | Where-Object { $_.model -and $_.model -notlike "*-free" })
  foreach ($row in $rows) {
    $stamp = ""
    if ($row.started_at) { $stamp = $row.started_at.Substring(0, 19) }
    Write-Output ("        " + $stamp + "  " + $row.operation + "  ->  " + $row.model)
  }
  $detail = ""
  if ($paid.Count -gt 0) {
    $detail = "发现付费模型: " + (($paid | ForEach-Object { $_.model }) -join ", ")
  } else {
    $detail = $rows.Count.ToString() + " 条全部是 *-free"
  }
  Check "最近调用全部是 *-free" ($paid.Count -eq 0) $detail
} catch {
  Check "读取 Hindsight 调用记录" $false $_.Exception.Message
}

Write-Output ""
if ($script:fails -eq 0) {
  Write-Output "ALL CHECKS PASSED — 零成本链路已打通"
  exit 0
}
Write-Output ($script:fails.ToString() + " CHECK(S) FAILED")
exit 1
