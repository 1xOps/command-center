# macOS checks (read-only)

| Area | Command | Read it as |
|---|---|---|
| OS and uptime | `sw_vers; uptime` | product version; days since boot |
| Hardware | `sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize` | CPU, cores, memory in bytes |
| Disk | `df -H /System/Volumes/Data` | "Avail" and "Capacity" of the data volume, the one that fills |
| Memory | `memory_pressure \| tail -1; sysctl vm.swapusage` | free percentage; swap used |
| CPU | `top -l 1 -n 10 -o cpu -stats pid,command,cpu,mem` | top 10 by CPU in one sample |
| Battery | `pmset -g batt; system_profiler SPPowerDataType \| grep -E "Cycle Count\|Condition\|Maximum Capacity"` | charge, cycles, condition |
| Updates | `softwareupdate -l` | contacts Apple and can take a minute: tell the person first |
| Startup items | `ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons` | third-party items that start at login or boot |
| Largest folders | `du -sh ~/* ~/Library/Caches ~/Library/Developer 2>/dev/null \| sort -h \| tail -15` | developer and app caches often hold tens of GB |
| Local snapshots | `tmutil listlocalsnapshots /` | Time Machine snapshots can hold free space |
