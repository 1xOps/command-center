# Linux checks (read-only)

| Area | Command | Read it as |
|---|---|---|
| OS and uptime | `cat /etc/os-release; uptime` | distribution and version; load averages for 1, 5 and 15 minutes |
| Hardware | `nproc; lscpu \| head -15` | cores and CPU model |
| Disk | `df -h -x tmpfs -x devtmpfs` | "Use%" per real file system |
| Inodes | `df -i /` | a full inode table stops writes even with free space |
| Memory | `free -h` | the "available" column, not "free" |
| CPU | `top -b -n 1 \| head -20` | load and top processes in one sample |
| Failed services | `systemctl --failed` | every unit listed is a finding |
| Errors since boot | `journalctl -p err -b --no-pager \| tail -30` | repeated errors; may need the `adm` or `systemd-journal` group |
| Battery | `cat /sys/class/power_supply/BAT*/capacity /sys/class/power_supply/BAT*/status` | absent on desktops and servers |
| Updates | Debian or Ubuntu `apt list --upgradable`; Fedora or RHEL `dnf check-update`; Arch `checkupdates` | count, and any security packages |
| Largest folders | `du -xh --max-depth=1 ~ 2>/dev/null \| sort -h \| tail -15` | biggest folders in the home folder |

In a container (`/.dockerenv` exists), hardware and update results describe the image, not the host; the report says so.
