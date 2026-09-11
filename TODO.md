# TODO

- [ ] **subagents: глубокая интеграция с herdr через agent-surface.** Сейчас
      вотчер завершения и stalled-детект — собственные (activity-файл + сайдкары).
      herdr умеет больше нативно: `herdr agent prompt <name> --wait` (отправка
      промта и ожидание settled-состояния), `herdr agent wait --until blocked`
      (субагент запросил approval/ответ), бейджи working/blocked/idle уже
      работают сами (herdr распознаёт pi). Идея: `subagent_message` для
      herdr-панелей шлёт промт через `agent prompt`, а вотчер дополнительно
      подхватывает `blocked`-состояния детей и уведомляет родителя.
      Справка: `herdr --skill`, https://herdr.dev/docs/agent-skill/
      (проверено на herdr 0.9.0, сентябрь 2026).
