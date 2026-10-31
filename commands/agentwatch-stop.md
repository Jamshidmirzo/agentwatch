---
description: Остановить офис AgentWatch (он снова поднимется при следующей сессии Claude Code)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/ensure.js" --stop`

Коротко передай пользователю результат из вывода выше.
