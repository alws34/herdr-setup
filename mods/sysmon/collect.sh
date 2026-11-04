# Prints one snapshot of this machine for the sysmon mod: sections start with "@name", raw
# tool output follows, and main.js parses it. Runs on macOS and Linux with stock tools;
# on Apple Silicon `macmon` (brew) adds CPU/GPU temperatures, power and per-core load,
# on Linux `nvidia-smi` adds GPUs. Sent as `sh -c` text so it runs on remote machines too.
export LC_ALL=C PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin"
echo "@host"; uname -sn
if [ "$(uname -s)" = Darwin ]; then
  echo "@ncpu"; sysctl -n hw.ncpu
  echo "@load"; sysctl -n vm.loadavg
  echo "@uptime"; sysctl -n kern.boottime
  echo "@cpuname"; sysctl -n machdep.cpu.brand_string
  if command -v macmon >/dev/null 2>&1; then echo "@macmon"; macmon pipe -s 1 -i 250 2>/dev/null
  else echo "@top"; top -l 2 -n 0 -s 1 | grep '^CPU usage' | tail -1; fi
  echo "@memsize"; sysctl -n hw.memsize
  echo "@vmstat"; vm_stat
  echo "@swap"; sysctl -n vm.swapusage
  echo "@gpu"; ioreg -r -d 1 -w 0 -c IOAccelerator | grep -o '"PerformanceStatistics" = {[^}]*}' | head -1
  echo "@net"; netstat -ibn | awk 'NR>1 && $3 ~ /^<Link/ && $1 !~ /^(lo|utun|awdl|llw|bridge|gif|stf|anpi|ap)/ { if (NF >= 11) { i+=$7; o+=$10 } else { i+=$6; o+=$9 } } END {print i+0, o+0}'
  echo "@ps"; ps -Ao pid=,pcpu=,pmem=,rss=,comm= -r | head -5
else
  echo "@ncpu"; nproc
  echo "@load"; cut -d' ' -f1-3 /proc/loadavg
  echo "@uptime"; cut -d' ' -f1 /proc/uptime
  echo "@cpuname"; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2
  echo "@stat1"; grep '^cpu' /proc/stat; sleep 1
  echo "@stat2"; grep '^cpu' /proc/stat
  echo "@meminfo"; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
  echo "@thermal"; for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && echo "$(cat "$z/type") $(cat "$z/temp")"; done 2>/dev/null
  if command -v nvidia-smi >/dev/null 2>&1; then echo "@nvidia"; nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits 2>/dev/null; fi
  echo "@net"; awk -F'[: ]+' 'NR>2 && $2 !~ /^(lo|docker|veth|br-)/ {i+=$3; o+=$11} END {print i+0, o+0}' /proc/net/dev
  echo "@ps"; ps -eo pid=,pcpu=,pmem=,rss=,comm= --sort=-pcpu | head -5
fi
echo "@df"; df -kP 2>/dev/null
echo "@mount"; mount
