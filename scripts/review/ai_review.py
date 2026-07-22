#!/usr/bin/env python3
"""Кросс-модельный ревьюер PR (OpenAI GPT) — «второй ключ».

Независимость: ИНАЯ модель (GPT vs Claude-автор) + иная личность (CI-бот) + событийный
триггер (CI на pull_request). Читает diff + AGENTS.md, выносит вердикт, ставит статус-гейт
`codex-review` и постит ревью-комментарий.

Политика отказа: реальный вердикт REQUEST_CHANGES → статус failure (мердж заблокирован).
Инфраструктурный сбой (модель/ключ/сеть) → статус success + громкий комментарий (не блокируем
команду; детерминированный money-гейт — отдельный автотест на цифры, не этот LLM-ревьюер).
"""
import os, json, sys, urllib.request, urllib.error

GH = "https://api.github.com"
OAI = "https://api.openai.com/v1/chat/completions"
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.6")
REPO = os.environ["GITHUB_REPOSITORY"]
PR = os.environ["PR_NUMBER"]
SHA = os.environ["HEAD_SHA"]
GHTOK = os.environ["GITHUB_TOKEN"]
OAITOK = os.environ["OPENAI_API_KEY"]


def gh(path, method="GET", data=None, accept="application/vnd.github+json"):
    req = urllib.request.Request(GH + path, method=method,
                                 headers={"Authorization": f"Bearer {GHTOK}", "Accept": accept})
    if data is not None:
        req.data = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    return urllib.request.urlopen(req)


def set_status(state, desc):
    try:
        gh(f"/repos/{REPO}/statuses/{SHA}", "POST",
           {"state": state, "context": "codex-review", "description": desc[:140]})
    except Exception as e:
        print("status error:", e)


def comment(body):
    try:
        gh(f"/repos/{REPO}/pulls/{PR}/reviews", "POST", {"event": "COMMENT", "body": body})
    except Exception:
        try:
            gh(f"/repos/{REPO}/issues/{PR}/comments", "POST", {"body": body})
        except Exception as e:
            print("comment error:", e)


def fail_open(msg):
    """Инфраструктурный сбой — не блокируем команду, но громко сообщаем."""
    comment(f"⚠️ Автоматический ревьюер не смог прогнаться: {msg}\nГейт пропущен (не блокирую). Проверьте модель/ключ/логи Action.")
    set_status("success", "ревьюер не прогнался — пропущено")
    sys.exit(0)


# --- сбор контекста ---
try:
    diff = gh(f"/repos/{REPO}/pulls/{PR}", accept="application/vnd.github.diff").read().decode("utf-8", "replace")[:120000]
    meta = json.load(gh(f"/repos/{REPO}/pulls/{PR}"))
except Exception as e:
    fail_open(f"не смог получить PR/diff: {e}")

try:
    agents = gh(f"/repos/{REPO}/contents/AGENTS.md", accept="application/vnd.github.raw").read().decode("utf-8", "replace")
except Exception:
    agents = "(AGENTS.md в репозитории нет)"

author = meta.get("user", {}).get("login", "?")
title = meta.get("title", "")

SYSTEM = (
    "Ты — независимый адверсариальный ревьюер PR. Ты ДРУГАЯ модель, чем автор кода. "
    "Задача — доказать, что PR НЕ готов; не смог — одобряешь (APPROVE). "
    "Суди СТРОГО по diff и правилам репозитория (AGENTS.md ниже). НЕ выдумывай требований, которых нет в правилах.\n"
    "Точные правила гейтов (не расширяй их):\n"
    "1) Запись в CHANGELOG.md обязательна ТОЛЬКО если PR меняет файлы приложения — 'web/' или 'scripts/migrations/'. "
    "Чисто инфраструктурные/процессные/документационные PR (.github/, scripts/review/, docs/, отдельные *.md) CHANGELOG НЕ требуют.\n"
    "2) Детерминированный автотест обязателен ТОЛЬКО если PR меняет цифры/расчёты ('scripts/migrations/', формулы, отчёты).\n"
    "3) При правке 'web/' или расчётов — обновить инструкцию по затронутой роли (лента «Что нового»/тултипы, product-guide, field-guide, data-dictionary).\n"
    "Ставь REQUEST_CHANGES ТОЛЬКО при реальном нарушении этих правил ИЛИ подтверждённом в diff баге/регрессии/уязвимости. "
    "Сомневаешься или это стиль/придирка — APPROVE или COMMENT, не блокируй.\n"
    "Ответь СТРОГО валидным JSON и ничем больше: "
    '{"verdict":"APPROVE|REQUEST_CHANGES|COMMENT","summary":"одна строка по-русски","findings":["что и где, чего не хватает"]}. '
    "Если всё чисто — findings: []."
)
USER = f"# AGENTS.md\n{agents}\n\n# PR #{PR}: {title} (автор {author})\n\n# DIFF\n{diff}"

payload = {
    "model": MODEL,
    "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}],
    "response_format": {"type": "json_object"},
}
req = urllib.request.Request(OAI, data=json.dumps(payload).encode(),
                             headers={"Authorization": f"Bearer {OAITOK}", "Content-Type": "application/json"})
try:
    resp = json.load(urllib.request.urlopen(req))
    content = resp["choices"][0]["message"]["content"]
    v = json.loads(content)
except urllib.error.HTTPError as e:
    fail_open(f"OpenAI {e.code}: {e.read().decode('utf-8','replace')[:300]}")
except Exception as e:
    fail_open(f"разбор ответа модели: {e}")

verdict = str(v.get("verdict", "COMMENT")).upper()
summary = str(v.get("summary", ""))
findings = v.get("findings", []) or []

body = f"🤖 Кросс-модельное ревью ({MODEL}, независимый второй ключ).\n\n**Вердикт:** {verdict}\n**Итог:** {summary}\n"
if findings:
    body += "\n" + "\n".join(f"- {f}" for f in findings)
comment(body)

if verdict == "REQUEST_CHANGES":
    set_status("failure", summary or "нужны правки")
else:
    set_status("success", summary or verdict)
print("verdict:", verdict)
