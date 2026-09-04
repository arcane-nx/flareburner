#!/usr/bin/env bash
#
# flareburner — Interactive Terminal User Interface (TUI)
# Manage service lifecycle (start / stop / restart) and view logs.
#
set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${PROJECT_DIR}/flareburner.pid"
LOG_FILE="${PROJECT_DIR}/flareburner.log"
ENV_FILE="${PROJECT_DIR}/.env"

# Colors
ESC="\033"
C_RESET="${ESC}[0m"
C_BOLD="${ESC}[1m"
C_DIM="${ESC}[2m"
C_RED="${ESC}[1;31m"
C_GREEN="${ESC}[1;32m"
C_YELLOW="${ESC}[1;33m"
C_BLUE="${ESC}[1;34m"
C_MAGENTA="${ESC}[1;35m"
C_CYAN="${ESC}[1;36m"
C_WHITE="${ESC}[1;37m"
C_BG_SELECT="${ESC}[46;30m" # Cyan background, black text

# Read PORT from .env
get_port() {
  local port=4001
  if [[ -f "${ENV_FILE}" ]]; then
    local val
    val=$(grep -E '^PORT=' "${ENV_FILE}" | cut -d= -f2- | tr -d ' "' | tr -d '\r')
    if [[ -n "${val}" ]]; then
      port="${val}"
    fi
  fi
  echo "${port}"
}

# Check if systemd service is installed
has_systemd_service() {
  if command -v systemctl >/dev/null 2>&1 && [[ -f /etc/systemd/system/flareburner.service ]]; then
    return 0
  fi
  return 1
}

# Get current status
# Returns: STATUS_CODE (RUNNING, STOPPED)
# Also sets: RUN_MODE, RUN_PID, HEALTH_INFO, UPTIME_INFO
check_status() {
  PORT="$(get_port)"
  STATUS_CODE="STOPPED"
  RUN_MODE="none"
  RUN_PID=""
  HEALTH_INFO="N/A"
  UPTIME_INFO="N/A"

  # 1. Check systemd if available
  if has_systemd_service; then
    if systemctl is-active --quiet flareburner 2>/dev/null; then
      STATUS_CODE="RUNNING"
      RUN_MODE="systemd"
      RUN_PID="$(systemctl show --property MainPID --value flareburner 2>/dev/null || echo '')"
    fi
  fi

  # 2. Check PID file if not detected via systemd
  if [[ "${STATUS_CODE}" == "STOPPED" && -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      STATUS_CODE="RUNNING"
      RUN_MODE="nohup"
      RUN_PID="${pid}"
    fi
  fi

  # 3. Check process table if still not detected
  if [[ "${STATUS_CODE}" == "STOPPED" ]]; then
    local pids
    pids="$(pgrep -f "node.*src/server\.js" 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      STATUS_CODE="RUNNING"
      RUN_MODE="process"
      RUN_PID="$(echo "${pids}" | head -n1)"
    fi
  fi

  # 4. Probe HTTP health
  PROXY_INFO="none"
  SESSIONS_INFO=""
  if command -v curl >/dev/null 2>&1; then
    local health_json
    health_json="$(curl -s -m 1 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
    if [[ -n "${health_json}" && "${health_json}" == *"\"status\":\"ok\""* ]]; then
      STATUS_CODE="RUNNING"
      HEALTH_INFO="Healthy (HTTP 200)"
      if command -v node >/dev/null 2>&1; then
        local details
        details="$(node -e '
          try {
            const data = JSON.parse(process.argv[1]);
            const up = data.uptimeSeconds || 0;
            const h = Math.floor(up / 3600);
            const m = Math.floor((up % 3600) / 60);
            const s = up % 60;
            const time = (h > 0 ? h + "h " : "") + (m > 0 || h > 0 ? m + "m " : "") + s + "s";
            const pool = (data.pool ? data.pool.busy + "/" + data.pool.size + " busy" : "");
            const cache = (data.clearanceCache ? data.clearanceCache.size + " cached" : "");
            const sess = data.sessions ? String(data.sessions.active) : "0";
            const prx = data.proxy || "none";
            console.log(time + "|" + pool + "|" + cache + "|" + sess + "|" + prx);
          } catch { console.log("||||"); }
        ' "${health_json}" 2>/dev/null || echo "||||")"

        UPTIME_INFO="$(echo "${details}" | cut -d'|' -f1)"
        local p_info c_info
        p_info="$(echo "${details}" | cut -d'|' -f2)"
        c_info="$(echo "${details}" | cut -d'|' -f3)"
        local s_info prx_val
        s_info="$(echo "${details}" | cut -d'|' -f4)"
        prx_val="$(echo "${details}" | cut -d'|' -f5)"
        if [[ -n "${p_info}" ]]; then
          HEALTH_INFO="Pool: ${p_info}, Clearance: ${c_info}"
        fi
        if [[ -n "${s_info}" && "${s_info}" != "0" ]]; then
          SESSIONS_INFO="${s_info} active"
        fi
        if [[ -n "${prx_val}" && "${prx_val}" != "none" ]]; then
          PROXY_INFO="Enabled"
        fi
      fi
    else
      if [[ "${STATUS_CODE}" == "RUNNING" ]]; then
        HEALTH_INFO="Starting / Unreachable on :${PORT}"
      fi
    fi
  fi
}

sync_systemd_service() {
  if has_systemd_service; then
    if grep -qE "flareburner/server\.js" /etc/systemd/system/flareburner.service 2>/dev/null; then
      echo -e "${C_YELLOW}Updating outdated ExecStart path in /etc/systemd/system/flareburner.service...${C_RESET}"
      if [[ "${EUID}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
        sudo sed -i 's|flareburner/server\.js|flareburner/src/server.js|g' /etc/systemd/system/flareburner.service
        sudo systemctl daemon-reload
      else
        sed -i 's|flareburner/server\.js|flareburner/src/server.js|g' /etc/systemd/system/flareburner.service
        systemctl daemon-reload
      fi
    fi
  fi
}

start_service() {
  sync_systemd_service
  check_status
  if [[ "${STATUS_CODE}" == "RUNNING" ]]; then
    echo -e "${C_YELLOW}flareburner is already running! (PID: ${RUN_PID:-unknown})${C_RESET}"
    read -rp "Press Enter to continue..." _
    return
  fi

  echo -e "${C_CYAN}Starting flareburner...${C_RESET}"
  if has_systemd_service; then
    echo -e "${C_DIM}Starting via systemd (systemctl start flareburner)...${C_RESET}"
    if [[ "${EUID}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
      sudo systemctl start flareburner
    else
      systemctl start flareburner
    fi
  else
    echo -e "${C_DIM}Starting via background nohup...${C_RESET}"
    cd "${PROJECT_DIR}"
    PORT="${PORT}" nohup node src/server.js >> "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"
  fi

  echo -e "Waiting for startup..."
  sleep 2
  check_status
  if [[ "${STATUS_CODE}" == "RUNNING" ]]; then
    echo -e "${C_GREEN}✓ flareburner started successfully!${C_RESET}"
  else
    echo -e "${C_RED}✗ Failed to start. Check logs for details.${C_RESET}"
  fi
  read -rp "Press Enter to continue..." _
}

stop_service() {
  check_status
  if [[ "${STATUS_CODE}" != "RUNNING" ]]; then
    echo -e "${C_YELLOW}flareburner is not running.${C_RESET}"
    read -rp "Press Enter to continue..." _
    return
  fi

  echo -e "${C_CYAN}Stopping flareburner...${C_RESET}"
  if has_systemd_service && systemctl is-active --quiet flareburner 2>/dev/null; then
    echo -e "${C_DIM}Stopping via systemd (systemctl stop flareburner)...${C_RESET}"
    if [[ "${EUID}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
      sudo systemctl stop flareburner
    else
      systemctl stop flareburner
    fi
  fi

  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi

  # Terminate any stray node src/server.js processes
  local strays
  strays="$(pgrep -f "node.*src/server\.js" 2>/dev/null || true)"
  if [[ -n "${strays}" ]]; then
    for p in ${strays}; do
      kill "${p}" 2>/dev/null || true
    done
  fi

  sleep 1
  check_status
  if [[ "${STATUS_CODE}" == "STOPPED" ]]; then
    echo -e "${C_GREEN}✓ flareburner stopped.${C_RESET}"
  else
    echo -e "${C_YELLOW}Service may still be shutting down...${C_RESET}"
  fi
  read -rp "Press Enter to continue..." _
}

restart_service() {
  sync_systemd_service
  echo -e "${C_CYAN}Restarting flareburner...${C_RESET}"
  if has_systemd_service; then
    if [[ "${EUID}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
      sudo systemctl restart flareburner
    else
      systemctl restart flareburner
    fi
    sleep 2
    check_status
    if [[ "${STATUS_CODE}" == "RUNNING" ]]; then
      echo -e "${C_GREEN}✓ flareburner restarted successfully!${C_RESET}"
    else
      echo -e "${C_RED}✗ Restart failed. Check logs.${C_RESET}"
    fi
    read -rp "Press Enter to continue..." _
  else
    stop_service
    start_service
  fi
}

follow_live_logs() {
  clear
  echo -e "${C_BOLD}${C_CYAN}=== flareburner Live Logs ===${C_RESET}"
  echo -e "${C_DIM}(Press Ctrl+C to stop following logs and return to menu)${C_RESET}\n"

  if has_systemd_service; then
    if [[ "${EUID}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
      sudo journalctl -u flareburner -f -n 50 || true
    else
      journalctl -u flareburner -f -n 50 || true
    fi
  elif [[ -f "${LOG_FILE}" ]]; then
    tail -n 50 -f "${LOG_FILE}" || true
  else
    echo -e "${C_YELLOW}No log file found at ${LOG_FILE} and systemd service not found.${C_RESET}"
    read -rp "Press Enter to return..." _
  fi
}

view_recent_logs() {
  clear
  echo -e "${C_BOLD}${C_CYAN}=== flareburner Last 50 Log Lines ===${C_RESET}\n"

  if has_systemd_service; then
    journalctl -u flareburner -n 50 --no-pager 2>/dev/null || true
  elif [[ -f "${LOG_FILE}" ]]; then
    tail -n 50 "${LOG_FILE}"
  else
    echo -e "${C_YELLOW}No log file found at ${LOG_FILE}.${C_RESET}"
  fi

  echo ""
  read -rp "Press Enter to return to menu..." _
}

run_health_probe() {
  clear
  echo -e "${C_BOLD}${C_CYAN}=== flareburner Health & API Probe ===${C_RESET}\n"
  PORT="$(get_port)"
  echo -e "Testing ${C_BOLD}http://127.0.0.1:${PORT}/health${C_RESET}...\n"
  if command -v curl >/dev/null 2>&1; then
    curl -i -m 3 "http://127.0.0.1:${PORT}/health" || echo -e "\n${C_RED}Connection failed.${C_RESET}"
  else
    echo -e "${C_RED}curl command not found.${C_RESET}"
  fi
  echo ""
  read -rp "Press Enter to return to menu..." _
}

view_metrics() {
  clear
  echo -e "${C_BOLD}${C_CYAN}=== flareburner Operational Metrics (Prometheus) ===${C_RESET}\n"
  PORT="$(get_port)"
  echo -e "Fetching ${C_BOLD}http://127.0.0.1:${PORT}/metrics${C_RESET}...\n"
  if command -v curl >/dev/null 2>&1; then
    local output
    output="$(curl -s -m 3 "http://127.0.0.1:${PORT}/metrics" 2>/dev/null || true)"
    if [[ -n "${output}" ]]; then
      echo -e "${C_GREEN}${output}${C_RESET}"
    else
      echo -e "${C_RED}Failed to reach /metrics on port ${PORT}.${C_RESET}"
    fi
  else
    echo -e "${C_RED}curl command not found.${C_RESET}"
  fi
  echo ""
  read -rp "Press Enter to return to menu..." _
}

# Menu items
OPTIONS=(
  "Start Service"
  "Stop Service"
  "Restart Service"
  "Follow Live Logs"
  "View Last 50 Log Lines"
  "Run Health Probe"
  "View Operational Metrics"
  "Exit"
)

SELECTED=0

draw_menu() {
  clear
  check_status

  echo -e "${C_CYAN}┌──────────────────────────────────────────────────────────────┐${C_RESET}"
  echo -e "${C_CYAN}│${C_RESET}                   ${C_BOLD}🔥 FLAREBURNER MANAGER 🔥${C_RESET}                  ${C_CYAN}│${C_RESET}"
  echo -e "${C_CYAN}│${C_RESET}              Cloudflare-Bypass Scraping Daemon               ${C_CYAN}│${C_RESET}"
  echo -e "${C_CYAN}└──────────────────────────────────────────────────────────────┘${C_RESET}"

  # Status Banner
  if [[ "${STATUS_CODE}" == "RUNNING" ]]; then
    echo -e "  STATUS  : ${C_GREEN}● RUNNING${C_RESET} (${RUN_MODE:-active})"
    echo -e "  PORT    : ${C_WHITE}${PORT}${C_RESET}"
    if [[ -n "${RUN_PID}" ]]; then
      echo -e "  PID     : ${C_WHITE}${RUN_PID}${C_RESET}"
    fi
    echo -e "  HEALTH  : ${C_GREEN}${HEALTH_INFO}${C_RESET}"
    if [[ -n "${SESSIONS_INFO}" ]]; then
      echo -e "  SESSIONS: ${C_WHITE}${SESSIONS_INFO}${C_RESET}"
    fi
    if [[ "${PROXY_INFO}" != "none" ]]; then
      echo -e "  PROXY   : ${C_CYAN}${PROXY_INFO}${C_RESET}"
    fi
    if [[ "${UPTIME_INFO}" != "N/A" ]]; then
      echo -e "  UPTIME  : ${C_WHITE}${UPTIME_INFO}${C_RESET}"
    fi
  else
    echo -e "  STATUS  : ${C_RED}○ STOPPED${C_RESET}"
    echo -e "  PORT    : ${C_DIM}${PORT}${C_RESET}"
  fi

  echo -e "\n${C_CYAN}┌─────────────────────────── MENU ─────────────────────────────┐${C_RESET}"
  for i in "${!OPTIONS[@]}"; do
    local opt="${OPTIONS[$i]}"
    local num=$((i + 1))
    local prefix="  [${num}]  "
    if [[ $i -eq 7 ]]; then
      prefix="  [q]  "
    fi

    if [[ $i -eq $SELECTED ]]; then
      local pad=$((60 - ${#prefix} - ${#opt}))
      echo -e "${C_CYAN}│${C_RESET} ${C_BG_SELECT}${C_BOLD}${prefix}${opt} ${C_RESET}$(printf '%*s' "${pad}" '')${C_CYAN}│${C_RESET}"
    else
      local pad=$((61 - ${#prefix} - ${#opt}))
      echo -e "${C_CYAN}│${C_RESET} ${prefix}${opt}$(printf '%*s' "${pad}" '')${C_CYAN}│${C_RESET}"
    fi
  done
  echo -e "${C_CYAN}└──────────────────────────────────────────────────────────────┘${C_RESET}"
  echo -e "${C_DIM}  Navigate: [↑/↓] Arrow Keys, [Enter] Select, or press [1-7, q]${C_RESET}"
}

run_option() {
  case $1 in
    0) start_service ;;
    1) stop_service ;;
    2) restart_service ;;
    3) follow_live_logs ;;
    4) view_recent_logs ;;
    5) run_health_probe ;;
    6) view_metrics ;;
    7) clear; echo "Goodbye!"; exit 0 ;;
  esac
}

# Main event loop
main() {
  # Trap Ctrl+C to cleanly exit
  trap 'clear; exit 0' SIGINT

  while true; do
    draw_menu

    # Read a single keypress or escape sequence
    IFS= read -rsn1 key

    # Handle Escape sequences (arrow keys)
    if [[ "$key" == $'\x1b' ]]; then
      read -rsn2 -t 0.1 rest
      key+="$rest"
    fi

    case "$key" in
      $'\x1b[A') # Up Arrow
        if [[ $SELECTED -gt 0 ]]; then
          SELECTED=$((SELECTED - 1))
        else
          SELECTED=$((${#OPTIONS[@]} - 1))
        fi
        ;;
      $'\x1b[B') # Down Arrow
        if [[ $SELECTED -lt $((${#OPTIONS[@]} - 1)) ]]; then
          SELECTED=$((SELECTED + 1))
        else
          SELECTED=0
        fi
        ;;
      "") # Enter key
        run_option $SELECTED
        ;;
      1) run_option 0 ;;
      2) run_option 1 ;;
      3) run_option 2 ;;
      4) run_option 3 ;;
      5) run_option 4 ;;
      6) run_option 5 ;;
      7) run_option 6 ;;
      q|Q) clear; echo "Goodbye!"; exit 0 ;;
    esac
  done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
