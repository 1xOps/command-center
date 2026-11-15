# Windows checks (PowerShell, read-only)

| Area | Command | Read it as |
|---|---|---|
| OS and uptime | `Get-CimInstance Win32_OperatingSystem \| Select-Object Caption, Version, LastBootUpTime` | edition, build, last boot |
| Hardware | `Get-CimInstance Win32_ComputerSystem \| Select-Object NumberOfLogicalProcessors, TotalPhysicalMemory` | cores; memory in bytes |
| Disk | `Get-Volume \| Where-Object DriveLetter \| Select-Object DriveLetter, SizeRemaining, Size` | free space per drive |
| Memory | `Get-CimInstance Win32_OperatingSystem \| Select-Object FreePhysicalMemory, TotalVisibleMemorySize` | both in KB |
| CPU | `Get-CimInstance Win32_Processor \| Select-Object LoadPercentage` | current load; repeat 3 times a few seconds apart |
| Battery | `Get-CimInstance Win32_Battery \| Select-Object EstimatedChargeRemaining, BatteryStatus` | the full report (`powercfg /batteryreport`) is the person's to run |
| Updates | `Get-HotFix \| Sort-Object InstalledOn -Descending \| Select-Object -First 5` | date of the last installed update |
| Startup items | `Get-CimInstance Win32_StartupCommand \| Select-Object Name, Command, Location` | programs that start at sign-in |
| Recent errors | `Get-WinEvent -FilterHashtable @{LogName='System'; Level=2} -MaxEvents 20` | repeated sources are findings |
| Largest folders | `Get-ChildItem $HOME -Directory \| ForEach-Object { [pscustomobject]@{ Name = $_.Name; GB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue \| Measure-Object Length -Sum).Sum / 1GB, 1) } } \| Sort-Object GB -Descending \| Select-Object -First 10` | slow on a large profile: set `timeout_ms` to 120000 |

Commands that need an administrator (`sfc`, `chkdsk`, `powercfg /energy`) are reported as "needs an administrator", not run.
