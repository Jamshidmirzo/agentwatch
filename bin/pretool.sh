#!/bin/sh
# Хук PreToolUse для AgentWatch. Если в офисе выбрали новый режим для этой сессии, на ближайшем
# безопасном инструменте (чтение/поиск) просим разрешение — тогда хук PermissionRequest переключит режим.
# Заодно отмечает текущий режим сессии (~/.agentwatch/seen/<session>) — чтобы офис его показывал.
# Без ожидающей смены режима молчит и ничего не меняет. Сеть не нужна: только файлы.
in=$(cat)
sid=$(printf '%s' "$in" | grep -o '"session_id" *: *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
case "$sid" in ''|*[!0-9a-fA-F-]*) exit 0 ;; esac
d="${AW_DIR:-$HOME/.agentwatch}"
pm=$(printf '%s' "$in" | grep -o '"permission_mode" *: *"[a-zA-Z]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
if [ -n "$pm" ] && [ -d "$d/seen" ] && [ "$(cat "$d/seen/$sid" 2>/dev/null)" != "$pm" ]; then printf '%s' "$pm" > "$d/seen/$sid"; fi
[ -f "$d/mode/$sid" ] || exit 0
tool=$(printf '%s' "$in" | grep -o '"tool_name" *: *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
case "$tool" in
  Read|Glob|Grep|LS|NotebookRead|WebSearch|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|ToolSearch) ;;
  *) exit 0 ;;
esac
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"AgentWatch: смена режима из офиса"}}'
