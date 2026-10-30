# AgentWatch

Локальный дашборд за живыми сессиями Claude Code (Terminal + VS Code) на этой машине.

```
./start.sh          # http://localhost:4777
PORT=5000 ./start.sh
```

Зависимостей нет (Node ≥ 18).

## Откуда данные
- `~/.claude/sessions/*.json` — реестр живых процессов Claude Code: pid, cwd, status (`busy` / `idle` / `waiting`), `waitingFor`.
- `~/.claude/projects/<slug>/<sessionId>.jsonl` — хвост транскрипта: AI-заголовок сессии, последний промпт, последний ответ, незавершённый tool_use (в т.ч. `AskUserQuestion` → текст вопроса и варианты).
- Terminal.app через AppleScript — соответствие tty → вкладка.

## Прыжок в сессию
- VS Code: `vscode://anthropic.claude-code/open?session=<id>` (deep link расширения).
- Terminal: AppleScript выбирает вкладку по tty и выводит окно вперёд.

## Дальше (идеи)
- Ответ прямо из дашборда через `/tmp/cc-socks/<pid>.sock`.
- Hook `Notification` в settings.json → мгновенный push вместо 2-секундного опроса.
- Выкатить на сервер + Telegram-пуш, когда агент ждёт.
