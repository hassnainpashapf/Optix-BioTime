param([string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path), [switch]$Tray, [ValidateSet('Start','Stop','Restart')][string]$Action)
$ErrorActionPreference = 'Stop'
$script:ConsoleScript = $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$taskName = 'OKT Attendance Server'
$dataDir = Join-Path $env:ProgramData 'OKT'
$dbFile = Join-Path $dataDir 'okt.db'
$configFile = Join-Path $dataDir 'server.json'

function TaskState { try { (Get-ScheduledTask -TaskName $taskName).State.ToString() } catch { 'Not installed' } }
function ManageTask([string]$operation) {
  try {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) {
      $args = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:ConsoleScript + '" -InstallDir "' + $InstallDir + '" -Action ' + $operation
      Start-Process powershell.exe -ArgumentList $args -Verb RunAs -Wait
      if ($state) { RefreshStatus }
      return
    }
    if ($operation -eq 'Start') { Start-ScheduledTask -TaskName $taskName }
    elseif ($operation -eq 'Stop') { Stop-ScheduledTask -TaskName $taskName }
    else { Stop-ScheduledTask -TaskName $taskName; Start-Sleep -Seconds 1; Start-ScheduledTask -TaskName $taskName }
    Start-Sleep -Milliseconds 800
    if ($state) { RefreshStatus }
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Could not $operation the server: $($_.Exception.Message)`nRun this console as Administrator.", 'ZKT Service Console') | Out-Null
  }
}
if ($Action) { ManageTask $Action; exit }
function RefreshStatus {
  $state.Text = 'Service: ' + (TaskState)
  $databaseStatus.Text = if (Test-Path $dbFile) { 'Database: available' } else { 'Database: missing' }
  $databasePath.Text = $dbFile
  $disk = Get-PSDrive -Name ([IO.Path]::GetPathRoot($dataDir).Substring(0,1)) -ErrorAction SilentlyContinue
  $diskStatus.Text = if ($disk) { 'Free space: ' + [math]::Round($disk.Free / 1GB, 1) + ' GB' } else { 'Free space: unknown' }
  try {
    $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
    $ports.Text = 'HTTP: ' + $cfg.http.port + '    HTTPS: ' + $(if ($cfg.https.enabled) { $cfg.https.port } else { 'off' })
  } catch { $ports.Text = 'Ports: configuration unavailable' }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ZKT Platform Service Console'
$form.Size = New-Object System.Drawing.Size(680,440)
$form.StartPosition = 'CenterScreen'
$form.Icon = New-Object System.Drawing.Icon((Join-Path $InstallDir 'okt.ico'))
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$form.Controls.Add($tabs)
foreach ($name in @('SERVICE','DATABASE','SYSTEM')) { $tab = New-Object System.Windows.Forms.TabPage; $tab.Text = $name; [void]$tabs.TabPages.Add($tab) }
function AddLabel($parent,$value,$x,$y,$width=580) { $c=New-Object System.Windows.Forms.Label; $c.Text=$value; $c.Location=New-Object System.Drawing.Point($x,$y); $c.Size=New-Object System.Drawing.Size($width,32); $parent.Controls.Add($c); return $c }
function AddButton($parent,$value,$x,$y,$action) { $c=New-Object System.Windows.Forms.Button; $c.Text=$value; $c.Location=New-Object System.Drawing.Point($x,$y); $c.Size=New-Object System.Drawing.Size(105,36); $c.Add_Click($action); $parent.Controls.Add($c) }
$serviceTab=$tabs.TabPages[0]
$state=AddLabel $serviceTab 'Service: checking' 30 35
AddButton $serviceTab 'Start' 30 82 { ManageTask 'Start' }
AddButton $serviceTab 'Stop' 145 82 { ManageTask 'Stop' }
AddButton $serviceTab 'Restart' 260 82 { ManageTask 'Restart' }
AddButton $serviceTab 'Check' 375 82 { RefreshStatus }
$ports=AddLabel $serviceTab 'Ports: checking' 30 150
AddLabel $serviceTab 'Change ports in System > Server Setting in the web app.' 30 192 | Out-Null
AddButton $serviceTab 'Open web app' 30 237 { try { $cfg=Get-Content $configFile -Raw | ConvertFrom-Json; Start-Process ('http://localhost:'+$cfg.http.port) } catch { Start-Process 'http://localhost:8888' } }
$databaseTab=$tabs.TabPages[1]
$databaseStatus=AddLabel $databaseTab 'Database: checking' 30 42
$databasePath=AddLabel $databaseTab '' 30 83
AddLabel $databaseTab 'This installation uses SQLite. Database backups are managed in the web app.' 30 132 | Out-Null
AddButton $databaseTab 'Connection test' 30 184 {
  $result = & (Join-Path $InstallDir 'node.exe') (Join-Path $InstallDir 'check-db.cjs') $dbFile 2>&1
  $message = if ($LASTEXITCODE -eq 0) { $result -join "`n" } else { 'Database check failed: ' + ($result -join "`n") }
  [System.Windows.Forms.MessageBox]::Show($message, 'ZKT Database') | Out-Null
  RefreshStatus
}
$systemTab=$tabs.TabPages[2]
$diskStatus=AddLabel $systemTab 'Free space: checking' 30 48
AddLabel $systemTab ('Version: '+(Get-Content (Join-Path $InstallDir 'app\package.json') -Raw | ConvertFrom-Json).version) 30 92 | Out-Null
AddLabel $systemTab ('Data folder: '+$dataDir) 30 132 | Out-Null
AddButton $systemTab 'Refresh' 30 188 { RefreshStatus }
$form.Add_Shown({ RefreshStatus })
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $form.Icon
$notify.Text = 'ZKT Attendance Server'
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Open Service Console', $null, { $form.Show(); $form.WindowState='Normal'; $form.Activate() })
[void]$menu.Items.Add('Exit', $null, { $notify.Visible=$false; $form.Close() })
$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ $form.Show(); $form.WindowState='Normal'; $form.Activate() })
if ($Tray) {
  $form.Add_Shown({ $form.Hide() })
  [System.Windows.Forms.Application]::Run($form)
} else { [void]$form.ShowDialog() }
$notify.Dispose()
