# ProofPipe Windows Taskbar Tray (WinForms NotifyIcon, zero native binaries).
# Launched silently via ProofPipe.bat or `npm run daemon -- tray`.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$DaemonJs = Join-Path $PSScriptRoot 'daemon.js'
$IconPng = Join-Path $Root 'extension\icon.png'
$Port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$DataDir = if ($env:PP_DATA) { $env:PP_DATA } else { Join-Path $Root 'data' }
$CertPem = Join-Path $DataDir 'cert.pem'
$Scheme = if (Test-Path $CertPem) { 'https' } else { 'http' }
$LogFile = Join-Path $DataDir 'proofpipe.log'

# Single-instance tray mutex so double-clicking ProofPipe.bat twice only focuses cleanly
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ProofPipeWindowsTray', [ref]$createdNew)
if (-not $createdNew) {
  exit 0
}

function Invoke-DaemonHidden {
  param([string[]]$Args)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = '"' + $DaemonJs + '" ' + ($Args -join ' ')
  $psi.WorkingDirectory = $Root
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Invoke-DaemonSync {
  param([string[]]$Args)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = '"' + $DaemonJs + '" ' + ($Args -join ' ')
  $psi.WorkingDirectory = $Root
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd()
  $p.WaitForExit(15000) | Out-Null
  return $out
}

function Fetch-Json {
  param([string]$Url)
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Timeout = 1200
    $req.ReadWriteTimeout = 1200
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $txt = $sr.ReadToEnd()
    $sr.Close()
    $resp.Close()
    return $txt | ConvertFrom-Json
  } catch {
    return $null
  }
}

# Ensure the background server is started cleanly
Invoke-DaemonHidden @('start')

$script:WebUrl = "${Scheme}://localhost:${Port}"
$script:PhoneUrl = $null
$script:Running = $false

# Load PNG into a crisp NotifyIcon (fallback to Application icon if absent)
$trayIcon = [System.Drawing.SystemIcons]::Application
if (Test-Path $IconPng) {
  try {
    $bmp = New-Object System.Drawing.Bitmap($IconPng)
    $hIcon = $bmp.GetHicon()
    $trayIcon = [System.Drawing.Icon]::FromHandle($hIcon)
  } catch {}
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $trayIcon
$notify.Text = 'ProofPipe — starting…'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem('ProofPipe — Checking…')
$miStatus.Enabled = $false

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem('Open Workbench')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miCopyPhone = New-Object System.Windows.Forms.ToolStripMenuItem('Copy Phone URL')
$miStart = New-Object System.Windows.Forms.ToolStripMenuItem('Start Server')
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem('Restart Server')
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem('Stop Server')
$miAutostart = New-Object System.Windows.Forms.ToolStripMenuItem('Start on Windows Login')
$miAutostart.CheckOnClick = $true
$miLogs = New-Object System.Windows.Forms.ToolStripMenuItem('Open Log File')
$miHideTray = New-Object System.Windows.Forms.ToolStripMenuItem('Close Tray (Keep Server Running)')
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem('Exit ProofPipe (Stop Server)')

[void]$menu.Items.Add($miStatus)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miOpen)
[void]$menu.Items.Add($miCopyPhone)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miStart)
[void]$menu.Items.Add($miRestart)
[void]$menu.Items.Add($miStop)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miAutostart)
[void]$menu.Items.Add($miLogs)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miHideTray)
[void]$menu.Items.Add($miExit)

$notify.ContextMenuStrip = $menu

function Refresh-State {
  $stats = Fetch-Json "${Scheme}://127.0.0.1:${Port}/api/stats"
  $lan = Fetch-Json "${Scheme}://127.0.0.1:${Port}/api/lan"
  $script:Running = ($null -ne $stats)
  $miStart.Enabled = -not $script:Running
  $miRestart.Enabled = $script:Running
  $miStop.Enabled = $script:Running

  if ($lan -and $lan.ips -and $lan.ips.Count -gt 0) {
    $script:PhoneUrl = "$($lan.scheme)://$($lan.ips[0]):$($lan.port)/phone"
    $miCopyPhone.Enabled = $true
  } else {
    $script:PhoneUrl = $null
    $miCopyPhone.Enabled = $false
  }

  if ($script:Running) {
    $phoneState = if ($stats.phoneOnline) { 'Phone connected' } else { 'Ready to pair' }
    $miStatus.Text = "● Live on :$Port · $phoneState"
    $tip = "ProofPipe · $phoneState · $($stats.count) caps"
  } else {
    $miStatus.Text = '○ Server Stopped'
    $tip = 'ProofPipe · Server stopped'
  }
  # NotifyIcon.Text throws if longer than 63 chars on Windows WinForms
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $notify.Text = $tip
}

# Read initial autostart toggle state once
try {
  $asJson = Invoke-DaemonSync @('autostart', 'status', '--json') | ConvertFrom-Json
  if ($asJson -and $asJson.enabled -eq $true) { $miAutostart.Checked = $true }
} catch {}

$openWorkbench = {
  Start-Process $script:WebUrl
}
$notify.Add_DoubleClick($openWorkbench)
$miOpen.Add_Click($openWorkbench)

$miCopyPhone.Add_Click({
  if ($script:PhoneUrl) {
    [System.Windows.Forms.Clipboard]::SetText($script:PhoneUrl)
    $notify.ShowBalloonTip(2000, 'ProofPipe', "Copied phone URL: $($script:PhoneUrl)", [System.Windows.Forms.ToolTipIcon]::Info)
  }
})

$miStart.Add_Click({ Invoke-DaemonHidden @('start') })
$miRestart.Add_Click({ Invoke-DaemonHidden @('restart') })
$miStop.Add_Click({ Invoke-DaemonHidden @('stop') })

$miAutostart.Add_Click({
  $action = if ($miAutostart.Checked) { 'enable' } else { 'disable' }
  Invoke-DaemonHidden @('autostart', $action)
})

$miLogs.Add_Click({
  if (Test-Path $LogFile) {
    Start-Process $LogFile
  } else {
    $notify.ShowBalloonTip(2000, 'ProofPipe', 'No log file created yet.', [System.Windows.Forms.ToolTipIcon]::None)
  }
})

$miHideTray.Add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$miExit.Add_Click({
  $timer.Stop()
  Invoke-DaemonSync @('stop') | Out-Null
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Refresh-State })
$timer.Start()

Refresh-State
[System.Windows.Forms.Application]::Run()
if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
