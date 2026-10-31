---
description: Открыть офис AgentWatch — 3D-офис всех сессий Claude Code
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/ensure.js" --status`

Скажи пользователю одной-двумя строками ссылку на офис из вывода выше (если офис только запускается — что первый запуск качает текстуры около минуты). Браузер сам не открывай.
