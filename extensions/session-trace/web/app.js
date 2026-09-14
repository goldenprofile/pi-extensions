/**
 * session-trace web — парсер JSONL-сессий pi + рендер таймлайна (без зависимостей).
 * Classic script: работает с file:// (без CORS). В node используется как смоук-тест:
 *   node app.js <session.jsonl>
 */
/* eslint-env browser */
(function () {
	"use strict";

	// ---------- форматирование ----------

	function fmtK(n) {
		if (!isFinite(n) || n === 0) return "0";
		if (n < 1000) return String(Math.round(n));
		if (n < 1e6) return (n / 1000).toFixed(1) + "k";
		return (n / 1e6).toFixed(1) + "M";
	}
	function fmtDur(ms) {
		if (ms === undefined || !isFinite(ms)) return "";
		if (ms < 1000) return Math.max(1, Math.round(ms)) + "ms";
		var s = ms / 1000;
		if (s < 60) return s.toFixed(1) + "s";
		return Math.floor(s / 60) + "m" + Math.round(s % 60) + "s";
	}
	function fmtClock(ms) {
		var d = new Date(ms);
		function p(x) { return String(x).padStart(2, "0"); }
		return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
	}
	function fmtMoney(c) {
		if (!isFinite(c) || c === 0) return "";
		return c < 0.01 ? "$" + c.toFixed(4) : "$" + c.toFixed(2);
	}
	function oneLine(s, max) {
		var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
		return t.length > (max || 80) ? t.slice(0, (max || 80) - 1) + "…" : t;
	}
	function esc(s) {
		return String(s).replace(/[&<>"]/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
		});
	}

	function entryMs(e) {
		var t = e && e.message && e.message.timestamp;
		if (typeof t === "number") return t;
		var p = Date.parse((e && e.timestamp) || "");
		return isFinite(p) ? p : 0;
	}
	function contentText(c) {
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			return c.filter(function (b) { return b && b.type === "text"; })
				.map(function (b) { return b.text || ""; }).join(" ");
		}
		return "";
	}
	function chipLabel(args) {
		var a = args || {};
		if (typeof a.agent === "string" && a.agent && a.task) return oneLine(a.agent + ": " + a.task, 64);
		if (typeof a.path === "string" && a.path) return oneLine(a.path, 64);
		if (typeof a.file_path === "string" && a.file_path) return oneLine(a.file_path, 64);
		if (typeof a.command === "string" && a.command) return oneLine(a.command, 72);
		if (typeof a.query === "string" && a.query) return oneLine(a.query, 64);
		if (typeof a.url === "string" && a.url) return oneLine(a.url, 64);
		try { return oneLine(JSON.stringify(a), 64); } catch (e) { return ""; }
	}

	// ---------- модель (порт session.ts) ----------

	function newModel() {
		return {
			items: [],
			sessionName: "",
			cwd: "",
			totals: { input: 0, output: 0, cost: 0 },
			turnNo: 0,
			byCallId: new Map(),
		};
	}

	function feedEntry(m, e) {
		if (!e || typeof e !== "object") return;
		var ts = entryMs(e);
		switch (e.type) {
			case "session": m.cwd = e.cwd || ""; break;
			case "session_info": if (e.name) m.sessionName = e.name; break;
			case "model_change": m.items.push({ kind: "marker", ts: ts, icon: "⚙", text: "model → " + e.provider + "/" + e.modelId }); break;
			case "thinking_level_change": m.items.push({ kind: "marker", ts: ts, icon: "✦", text: "thinking: " + e.thinkingLevel }); break;
			case "compaction": m.items.push({ kind: "marker", ts: ts, icon: "↻", text: "compaction" + (e.tokensBefore ? " · " + fmtK(e.tokensBefore) + " tok" : "") }); break;
			case "branch_summary": m.items.push({ kind: "marker", ts: ts, icon: "⑂", text: oneLine(e.summary || "branch", 110) }); break;
			case "label": if (e.label) m.items.push({ kind: "marker", ts: ts, icon: "⚑", text: oneLine(e.label, 80) }); break;
			case "custom":
				if ((e.customType === "session-trace:subagents" || e.customType === "pitrace:subagents") && e.data && e.data.session) {
					m.items.push({
						kind: "child", ts: ts,
						agent: String(e.data.agent || "?"),
						task: oneLine(e.data.task || "", 120),
						session: String(e.data.session),
						model: e.data.model,
						tokensOut: e.data.usage && e.data.usage.output,
						cost: e.data.usage && e.data.usage.cost,
					});
				}
				break;
			case "message": feedMessage(m, e, ts); break;
		}
	}

	function feedMessage(m, e, ts) {
		var msg = e.message;
		if (!msg) return;
		if (msg.role === "user") {
			var text = oneLine(contentText(msg.content), 160);
			if (text) m.items.push({ kind: "user", ts: ts, text: text });
		} else if (msg.role === "bashExecution") {
			m.items.push({ kind: "bash", ts: ts, command: oneLine(msg.command, 120), exitCode: msg.exitCode });
		} else if (msg.role === "assistant") {
			m.turnNo++;
			var turn = {
				kind: "turn", index: m.turnNo, startMs: ts,
				model: msg.model, tokensOut: msg.usage && msg.usage.output,
				cost: msg.usage && msg.usage.cost && msg.usage.cost.total,
				stopReason: msg.stopReason, errorMessage: msg.errorMessage,
				text: "", thinking: "", chips: [],
			};
			m.totals.input += (msg.usage && msg.usage.input) || 0;
			m.totals.output += (msg.usage && msg.usage.output) || 0;
			m.totals.cost += (msg.usage && msg.usage.cost && msg.usage.cost.total) || 0;
			(msg.content || []).forEach(function (b) {
				if (b && b.type === "toolCall" && b.id) {
					var chip = { callId: b.id, name: b.name || "?", label: chipLabel(b.arguments), status: "running", startMs: ts, endMs: undefined };
					turn.chips.push(chip);
					m.byCallId.set(b.id, chip);
				} else if (b && b.type === "thinking") {
					turn.thinking = oneLine(b.thinking, 140);
				} else if (b && b.type === "text" && !turn.text) {
					turn.text = oneLine(b.text, 140);
				}
			});
			m.items.push(turn);
		} else if (msg.role === "toolResult") {
			var chip2 = m.byCallId.get(msg.toolCallId);
			if (chip2) {
				chip2.status = msg.isError ? "error" : "ok";
				chip2.endMs = ts;
			}
		}
	}

	// ---------- рендер (браузер) ----------

	function itemHtml(it, focusTurn) {
		if (it.kind === "user") {
			return '<div class="user"><span class="dot">●</span> ' + esc(it.text) + "</div>";
		}
		if (it.kind === "bash") {
			var exit = it.exitCode ? ' <span class="err">exit ' + it.exitCode + "</span>" : "";
			return '<div class="marker bash"><span class="i">$</span> ' + esc(it.command) + exit + "</div>";
		}
		if (it.kind === "marker") {
			return '<div class="marker">├ <span class="i">' + it.icon + "</span> " + esc(it.text) + "</div>";
		}
		if (it.kind === "child") {
			var ch = '<div class="card child"><div class="t">⧉ субагент: <span class="model">' + esc(it.agent) + "</span> · " + fmtClock(it.ts) +
				(it.tokensOut ? " · ↓" + fmtK(it.tokensOut) : "") + (it.cost ? " · " + fmtMoney(it.cost) : "") + "</div>";
			ch += '<div class="prev text">' + esc(it.task) + "</div>";
			ch += '<div class="prev">→ /graph <span class="model">' + esc(it.session) + "</span></div>";
			return ch + "</div>";
		}
		// turn
		var running = it.chips.some(function (c) { return c.status === "running"; });
		var h = '<div class="card' + (running ? " live" : "") + (focusTurn === it.index ? " flash" : "") + '" id="t-' + it.index + '">';
		h += '<div class="t">T' + it.index + " · " + fmtClock(it.startMs) +
			(it.model ? ' · <span class="model">' + esc(it.model) + "</span>" : "") +
			(it.tokensOut ? " · ↓" + fmtK(it.tokensOut) : "") +
			(it.cost ? " · " + fmtMoney(it.cost) : "") +
			(it.stopReason === "aborted" ? ' · <span class="warn">aborted</span>' : "") +
			(running ? ' · <span class="warn">working</span>' : "") + "</div>";
		it.chips.forEach(function (c) {
			var st = c.status === "ok" ? '<span class="st ok">✓</span>'
				: c.status === "error" ? '<span class="st err">✗</span>'
				: '<span class="st run">⟳</span>';
			var dur = c.endMs !== undefined ? fmtDur(c.endMs - c.startMs) : "";
			h += '<div class="chip"><span class="tool">⚒ ' + esc(c.name) + "</span>" +
				'<span class="arg">' + esc(c.label) + "</span>" +
				'<span class="dur">' + dur + "</span>" + st + "</div>";
		});
		if (it.thinking) h += '<div class="prev think">⋮ ' + esc(it.thinking) + "</div>";
		if (it.text) h += '<div class="prev text">«' + esc(it.text) + "»</div>";
		if (it.errorMessage) h += '<div class="prev errline">✗ ' + esc(oneLine(it.errorMessage, 140)) + "</div>";
		return h + "</div>";
	}

	/** Проходит ли элемент под фильтрами (порт matches() из graph.ts). */
	function matchItem(it, q, errorsOnly) {
		if (errorsOnly) {
			var bad = (it.kind === "turn" && (it.errorMessage || it.chips.some(function (c) { return c.status === "error"; }))) ||
				(it.kind === "bash" && it.exitCode !== undefined && it.exitCode !== 0);
			if (!bad) return false;
		}
		if (!q) return true;
		var hay = it.kind === "turn"
			? ("T" + it.index) + " " + (it.text || "") + " " + (it.thinking || "") + " " + (it.model || "") + " " +
				it.chips.map(function (c) { return c.name + " " + c.label; }).join(" ")
			: it.kind === "marker" ? it.text
			: it.kind === "user" ? it.text
			: it.kind === "child" ? it.agent + " " + it.task + " " + it.session
			: it.command;
		return hay.toLowerCase().indexOf(q) !== -1;
	}

	function renderTimeline(model, el, opts) {
		opts = opts || {};
		var q = (opts.q || "").toLowerCase();
		var items = model.items.filter(function (it) { return matchItem(it, q, opts.errorsOnly); });
		var skip = Math.max(0, items.length - (opts.cap || 800));
		var html = "";
		if (skip > 0) html += '<div class="marker">… ' + skip + ' более ранних записей</div>';
		if (items.length === 0 && model.items.length > 0) {
			html += '<div class="marker">под фильтр ничего не попало</div>';
		}
		items.slice(skip).forEach(function (it) { html += itemHtml(it, opts.focusTurn); });
		// follow=false — пользователь ушёл от хвоста (скролл или выбор узла):
		// сохраняем позицию, а не прыгаем в конец при каждом рендере (раз в 100мс)
		var keep = el.scrollTop;
		el.innerHTML = html;
		el.scrollTop = opts.follow === false ? keep : el.scrollHeight;
	}

	// ---------- приложение ----------

	function boot() {
		var $ = function (id) { return document.getElementById(id); };
		var model = newModel();
		var entries = [];      // {ms, e}
		var fedCount = 0;
		var firstMs = 0;
		var playheadMs = 0;
		var playing = false;
		var speed = 8;
		var lastTick = 0;
		var fileName = "";
		var fileHandle = null; // File для автообновления
		var servedMode = false; // страница открыта через web/serve.ts — хвост тянем по fetch
		var errorsOnly = false;
		var stick = true; // держать ленту приклеенной к хвосту

		var el = {
			file: $("file"), stats: $("stats"), tl: $("timeline"), viz: $("viz"),
			play: $("play"), speed: $("speed"), end: $("toend"),
			slider: $("slider"), pos: $("pos"), drop: $("drop"),
			q: $("q"), errs: $("errs"),
			wbtn: $("wbtn"), wpanel: $("wpanel"),
		};

		function load(parsed) {
			model = newModel();
			entries = parsed;
			fedCount = 0;
			firstMs = entries.length ? entries[0].ms : 0;
			playheadMs = firstMs;
			entries.forEach(function (x) { feedEntry(model, x.e); });
			fedCount = entries.length; // стартуем с полной картиной; «с начала» — кнопкой ⟲
			el.file.textContent = fileName || "(без имени)";
			el.slider.max = String(Math.max(1, (entries[entries.length - 1]?.ms ?? 0) - firstMs));
			seekTo(playheadMs);
		}

		function feedUntil(ms) {
			while (fedCount < entries.length && entries[fedCount].ms <= ms) {
				feedEntry(model, entries[fedCount].e);
				fedCount++;
			}
		}

		function seekTo(ms) {
			playheadMs = ms;
			var lo = 0, hi = entries.length;
			while (lo < hi) { var mid = (lo + hi) >> 1; if (entries[mid].ms <= ms) lo = mid + 1; else hi = mid; }
			model = newModel();
			for (var i = 0; i < lo; i++) feedEntry(model, entries[i].e);
			fedCount = lo;
			draw();
		}

		function draw() {
			renderTimeline(model, el.tl, { q: el.q.value, errorsOnly: errorsOnly, follow: stick, focusTurn: selectedTurn });
			var left = model.sessionName ? model.sessionName + " · " : "";
			el.stats.innerHTML =
				'<span class="dim">' + esc(left + entries.length + " entries") + "</span> · " +
				"↑" + fmtK(model.totals.input) + " ↓" + fmtK(model.totals.output) +
				(model.totals.cost ? " · " + fmtMoney(model.totals.cost) : "");
			el.slider.value = String(Math.max(0, playheadMs - firstMs));
			el.pos.textContent = fmtClock(playheadMs) + " / " + fmtClock(entries.length ? entries[entries.length - 1].ms : 0);
		}

		function parseLines(text) {
			var out = [];
			text.split("\n").forEach(function (line) {
				var t = line.trim();
				if (!t) return;
				try {
					var e = JSON.parse(t);
					out.push({ ms: Date.parse(e.timestamp) || 0, e: e });
				} catch (err) { /* частичная строка — пропускаем */ }
			});
			return out;
		}

		function applyGrowth(parsed) {
			if (parsed.length <= entries.length) return;
			var atEnd = fedCount >= entries.length;
			for (var i = entries.length; i < parsed.length; i++) entries.push(parsed[i]);
			if (atEnd) {
				feedUntil(Infinity);
				playheadMs = entries.length ? entries[entries.length - 1].ms : 0;
			}
			draw();
		}

		function loadFile(f) {
			fileName = f.name;
			fileHandle = f;
			servedMode = false;
			var r = new FileReader();
			r.onload = function () { load(parseLines(String(r.result))); };
			r.readAsText(f);
		}
		// --- события ---
		// ручной скролл отрывает ленту от хвоста; возврат к низу — приклеивает обратно
		el.tl.addEventListener("scroll", function (ev) {
			if (!ev.isTrusted) return; // программная установка scrollTop — не жест пользователя
			stick = el.tl.scrollTop + el.tl.clientHeight >= el.tl.scrollHeight - 40;
		});
		el.q.oninput = function () { draw(); };
		el.errs.onclick = function () {
			errorsOnly = !errorsOnly;
			el.errs.classList.toggle("on", errorsOnly);
			draw();
		};
		// автообновление: перечитываем File (Chromium отражает изменения на диске)
		// или дергаем /session.jsonl (страница открыта через web/serve.ts)
		setInterval(function () {
			if (fileHandle) {
				fileHandle.text().then(function (t) {
					applyGrowth(parseLines(t));
				}).catch(function () { /* файл мог исчезнуть — не страшно */ });
			} else if (servedMode) {
				fetch("session.jsonl", { cache: "no-store" }).then(function (r) {
					return r.ok ? r.text() : null;
				}).then(function (t) {
					if (t) applyGrowth(parseLines(t));
				}).catch(function () { /* сервер могли остановить */ });
			}
		}, 2000);
		// --- живые task_batch-воркеры (глобальный индекс subagents) ---
		var workersList = [];
		function renderWorkers() {
			if (!workersList.length) {
				el.wbtn.classList.add("hidden");
				el.wpanel.classList.add("hidden");
				return;
			}
			el.wbtn.classList.remove("hidden");
			el.wbtn.classList.add("on");
			el.wbtn.textContent = "● " + workersList.length;
			var now = Date.now();
			el.wpanel.innerHTML = workersList.map(function (w, i) {
				var mode = w.mode ? ' <span class="dim">' + esc(w.mode) + (w.step ? " ·" + w.step : "") + ")</span>" : "";
				return '<div class="w" data-i="' + i + '" title="' + esc(w.sessionFile) + '">' +
					"<div class=\"head\"><span class=\"dot\">●</span><span>" + esc(w.label) + mode + "</span>" +
					"<span class=\"dim\">" + fmtDur(now - w.startedAt) + "</span>" +
					"<span class=\"dim\">pid " + w.pid + "</span></div>" +
					'<div class="task">' + esc(oneLine(w.task || "", 110)) + "</div></div>";
			}).join("");
		}
		function fetchWorkers() {
			if (!servedMode) return; // file:// и drag&drop — сервера нет
			fetch("workers", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; })
				.then(function (d) { if (d) { workersList = d.workers || []; renderWorkers(); } })
				.catch(function () { /* сервер могли остановить */ });
		}
		el.wbtn.onclick = function () {
			el.wpanel.classList.toggle("hidden");
			renderWorkers(); // свежий elapsed
		};
		el.wpanel.onclick = function (ev) {
			var wEl = ev.target && ev.target.closest ? ev.target.closest(".w") : null;
			if (!wEl) return;
			var w = workersList[Number(wEl.getAttribute("data-i"))];
			if (!w) return;
			// Переключаем сервер на сессию воркера и подтягиваем её с хвостом.
			fetch("load", { method: "POST", body: JSON.stringify({ file: w.sessionFile }) }).then(function (r) {
				if (!r.ok) return null;
				fileName = w.sessionFile.split(/[\\/]/).pop();
				fileHandle = null; servedMode = true;
				return fetch("session.jsonl", { cache: "no-store" }).then(function (r2) { return r2.ok ? r2.text() : null; });
			}).then(function (t) {
				if (t) { load(parseLines(t)); el.end.onclick(); }
			});
		};
		setInterval(fetchWorkers, 5000);
		fetchWorkers();
		el.play.onclick = function () {
			playing = !playing;
			if (playing && fedCount >= entries.length) seekTo(firstMs); // ⟲ с начала
			if (playing) stick = true;
			el.play.textContent = playing ? "⏸" : "▶";
			lastTick = performance.now();
		};
		el.end.onclick = function () {
			playing = false; stick = true; el.play.textContent = "▶";
			feedUntil(Infinity); playheadMs = entries.length ? entries[entries.length - 1].ms : 0; draw();
		};
		el.speed.onchange = function () { speed = Number(el.speed.value); };
		el.slider.oninput = function () {
			playing = false; el.play.textContent = "▶";
			seekTo(firstMs + Number(el.slider.value));
		};
		document.addEventListener("keydown", function (ev) {
			var typing = ev.target && ev.target.tagName === "INPUT";
			if (typing) return; // в поле фильтра клавиши не перехватываем
			if (ev.code === "Space" && ev.target === document.body) { ev.preventDefault(); el.play.onclick(); }
			if (ev.code === "ArrowLeft") { playing = false; el.play.textContent = "▶"; seekTo(playheadMs - 5000); }
			if (ev.code === "ArrowRight") { playing = false; el.play.textContent = "▶"; seekTo(playheadMs + 5000); }
		});
		["dragover", "drop"].forEach(function (t) {
			document.addEventListener(t, function (ev) { ev.preventDefault(); el.drop.classList.toggle("drag", t === "dragover"); });
		});
		document.addEventListener("drop", function (ev) {
			var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
			if (f) loadFile(f);
		});
		$("pick").onchange = function () { if (this.files[0]) loadFile(this.files[0]); };

		// Автозагрузка с сервера: web/serve.ts отдаёт сессию по относительному /session.jsonl.
		// С file:// fetch падает — молча остаёмся в режиме drag&drop.
		fetch("session.jsonl", { cache: "no-store" }).then(function (r) {
			if (!r.ok) return null;
			return r.text().then(function (t) {
				var name = r.headers.get("x-session-file");
				fileName = name ? decodeURIComponent(name) : "session.jsonl";
				servedMode = true;
				load(parseLines(t));
				// #end — открыть сразу с хвоста сессии (иначе реплей стоит в начале)
				if (location.hash === "#end" && entries.length) {
					seekTo(entries[entries.length - 1].ms);
				}
			});
		}).catch(function () { /* file:// — drag&drop */ });

		setInterval(function () {
			if (!playing) return;
			var now = performance.now();
			var dt = now - lastTick;
			lastTick = now;
			playheadMs += dt * speed;
			feedUntil(playheadMs);
			if (fedCount >= entries.length) { playing = false; el.play.textContent = "▶"; }
			draw();
		}, 100);

		// ---------- визуализация (canvas, в духе zoetrope) ----------

		var viz = (function () {
			var COLORS = {
				bg: "#151a21", line: "#2a3038", text: "#d7dde6", dim: "#7d8590",
				accent: "#e3b341", ok: "#3fb950", err: "#f85149", warn: "#d29922", tool: "#58c4dc",
			};
			var NODE_W = 96, NODE_H = 34, COL_GAP = 18, ROW_STEP = 64, PAD = 14;
			var zoom = 1, MIN_Z = 0.55, MAX_Z = 2.6, selectedTurn = -1;
			var graphCv = $("graph"), stripCv = $("strip");
			var dpr = window.devicePixelRatio || 1;
			var nodePos = []; // {x, y, turn}
			var mainRect = null;

			function resize() {
				// граф занимает всю высоту левой колонки минус лента-таймлайн (26 + бордер)
				var sH = 26;
				var gH = Math.max(140, el.viz.clientHeight - sH - 1);
				graphCv.width = graphCv.clientWidth * dpr; graphCv.height = gH * dpr;
				graphCv.style.height = gH + "px";
				stripCv.width = stripCv.clientWidth * dpr; stripCv.height = sH * dpr;
				stripCv.style.height = sH + "px";
			}
			window.addEventListener("resize", resize);
			resize();

			function turns() {
				return model.items.filter(function (it) { return it.kind === "turn"; });
			}

			function turnState(t) {
				if (t.chips.some(function (c) { return c.status === "running"; })) return "running";
				if (t.errorMessage || t.chips.some(function (c) { return c.status === "error"; })) return "error";
				return "ok";
			}

			function activeIndex(ts) {
				var last = -1;
				for (var i = 0; i < ts.length; i++) if (ts[i].startMs <= playheadMs) last = i;
				return last;
			}

			function rr(ctx, x, y, w, h, r) {
				ctx.beginPath();
				ctx.moveTo(x + r, y);
				ctx.arcTo(x + w, y, x + w, y + h, r);
				ctx.arcTo(x + w, y + h, x, y + h, r);
				ctx.arcTo(x, y + h, x, y, r);
				ctx.arcTo(x, y, x + w, y, r);
				ctx.closePath();
			}

			function draw() {
				var ctx = graphCv.getContext("2d");
				var W = graphCv.width / dpr, H = graphCv.height / dpr;
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, W, H);
				var z = zoom;
				var nw = NODE_W * z, nh = NODE_H * z, cg = COL_GAP * z, rs = ROW_STEP * z;
				var topY = 56 + 18 * z;
				var f1 = Math.max(8, 11 * z), f2 = Math.max(8, 9 * z);
				var ts = turns();
				var cols = Math.max(2, Math.floor((W - PAD * 2) / (nw + cg)));
				var rowsFit = Math.max(1, Math.floor((H - topY) / rs));
				var act = activeIndex(ts);
				var start = Math.max(0, Math.min(ts.length - cols * rowsFit, act - Math.floor(cols * rowsFit / 2)));
				var end = Math.min(ts.length, start + cols * rowsFit);
				var now = performance.now();
				// кликнутый узел не двигает плейхед — но окно графа центрируется на нём
				if (selectedTurn >= 0) {
					for (var si = 0; si < ts.length; si++) {
						if (ts[si].index === selectedTurn) {
							start = Math.max(0, Math.min(ts.length - cols * rowsFit, si - Math.floor(cols * rowsFit / 2)));
							end = Math.min(ts.length, start + cols * rowsFit);
							break;
						}
					}
				}

				// главный узел агента
				var mw = 150, mh = 44;
				var mx = PAD, my = PAD;
				mainRect = { x: mx, y: my, w: mw, h: mh };
				ctx.fillStyle = COLORS.bg;
				ctx.strokeStyle = playing || hasRunningChip() ? COLORS.accent : COLORS.line;
				ctx.lineWidth = 1.5;
				rr(ctx, mx, my, mw, mh, 8); ctx.fill(); ctx.stroke();
				ctx.fillStyle = COLORS.text;
				ctx.font = "bold 12px " + mono();
				ctx.fillText("pi agent", mx + 12, my + 18);
				ctx.fillStyle = COLORS.dim;
				ctx.font = "10px " + mono();
				var lastModel = ts.length ? ts[ts.length - 1].model : "";
				ctx.fillText(lastModel || "ожидание…", mx + 12, my + 33);
				if (playing || hasRunningChip()) {
					ctx.fillStyle = COLORS.accent;
					ctx.beginPath();
					ctx.arc(mx + mw - 14, my + 14, 4 + Math.sin(now / 180) * 1.5, 0, 7);
					ctx.fill();
				}

				nodePos = [];
				var prev = null; // {x, y, wrap}
				for (var i = start; i < end; i++) {
					var k = i - start;
					var row = Math.floor(k / cols), col = k % cols;
					var x = PAD + col * (nw + cg);
					var y = topY + row * rs;
					nodePos.push({ x: x, y: y, w: nw, h: nh, turn: ts[i] });
					// ребро от предыдущего
					if (prev) {
						ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1.5;
						ctx.beginPath();
						if (prev.wrap) {
							var midY = prev.y + nh / 2;
							ctx.moveTo(prev.x + nw, midY);
							ctx.lineTo(W - PAD, midY);
							ctx.lineTo(W - PAD, y + nh / 2);
							ctx.lineTo(x, y + nh / 2);
						} else {
							ctx.moveTo(prev.x + nw, prev.y + nh / 2);
							ctx.lineTo(x, y + nh / 2);
						}
						ctx.stroke();
					}
					// карточка
					var st = turnState(ts[i]);
					var isActive = i === act;
					var isSel = ts[i].index === selectedTurn;
					ctx.fillStyle = COLORS.bg;
					ctx.strokeStyle = st === "error" ? COLORS.err : isSel ? COLORS.accent : isActive ? COLORS.accent : COLORS.line;
					ctx.lineWidth = isSel || isActive ? 2 : 1.2;
					if (st === "running" && isActive) ctx.setLineDash([4, 3]);
					rr(ctx, x, y, nw, nh, 7); ctx.fill(); ctx.stroke();
					ctx.setLineDash([]);
					ctx.fillStyle = st === "error" ? COLORS.err : st === "running" ? COLORS.accent : COLORS.ok;
					ctx.beginPath(); ctx.arc(x + 10 * z, y + 12 * z, 3, 0, 7); ctx.fill();
					ctx.fillStyle = COLORS.text;
					ctx.font = "bold " + f1 + "px " + mono();
					ctx.fillText("T" + ts[i].index, x + 18 * z, y + 15 * z);
					ctx.fillStyle = COLORS.dim;
					ctx.font = f2 + "px " + mono();
					ctx.fillText((ts[i].tokensOut ? "↓" + fmtK(ts[i].tokensOut) : "") + (ts[i].cost ? " " + fmtMoney(ts[i].cost) : ""), x + 8 * z, y + 28 * z);
					// анимированные точки на активном ребре
					if (isActive && (playing || hasRunningChip()) && prev && !prev.wrap) {
						ctx.fillStyle = COLORS.accent;
						var off = (now / 8) % 12;
						var ey = y + nh / 2;
						for (var d = off; d < cg - 2; d += 12) {
							ctx.beginPath(); ctx.arc(prev.x + nw + d, ey, 1.6, 0, 7); ctx.fill();
						}
					}
					prev = { x: x, y: y, wrap: col === cols - 1 };
				}
				if (start > 0) dots(ctx, PAD, topY + nh / 2 - 8);
				if (end < ts.length) dots(ctx, W - PAD - 10, topY + Math.floor((end - start - 1) / cols) * rs + nh / 2 - 8);

				// дочерние субагенты — карточки под якорными узлами (ближайший ход по времени)
				var children = model.items.filter(function (it) { return it.kind === "child"; });
				children.forEach(function (chd) {
					var best = null, bestD = Infinity;
					nodePos.forEach(function (n) {
						var d = Math.abs(n.turn.startMs - chd.ts);
						if (d < bestD) { bestD = d; best = n; }
					});
					if (!best) return;
					var label = "⧉ " + chd.agent + (chd.tokensOut ? " ↓" + fmtK(chd.tokensOut) : "");
					ctx.font = Math.max(8, 10 * z) + "px " + mono();
					var cw = ctx.measureText(label).width + 16;
					var cxx = Math.min(best.x, W - PAD - cw);
					var cy = best.y + best.h + 5;
					ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.moveTo(best.x + best.w / 2, best.y + best.h);
					ctx.lineTo(best.x + best.w / 2, cy);
					ctx.stroke();
					ctx.fillStyle = COLORS.bg;
					ctx.strokeStyle = COLORS.accent;
					rr(ctx, cxx, cy, cw, 16, 6); ctx.fill(); ctx.stroke();
					ctx.fillStyle = COLORS.accent;
					ctx.fillText(label, cxx + 8, cy + 11.5);
				});

				// чипы инструментов активного хода — под его рядом
				if (act >= start && act < end) drawChips(ctx, ts[act], PAD, topY + Math.floor((act - start) / cols) * rs + nh + 8, W);
			}

			function hasRunningChip() {
				return model.items.some(function (it) {
					return it.kind === "turn" && it.chips.some(function (c) { return c.status === "running"; });
				});
			}

			function dots(ctx, x, y) {
				ctx.fillStyle = COLORS.dim;
				ctx.font = "12px " + mono();
				ctx.fillText("…", x, y + 10);
			}

			function mono() { return 'ui-monospace, Consolas, monospace'; }

			function drawChips(ctx, turn, x, y, maxW) {
				if (!turn.chips.length) return;
				ctx.save();
				ctx.font = "10px " + mono();
				var cx = x;
				var shown = 0;
				for (var i = 0; i < turn.chips.length && shown < 7; i++) {
					var c = turn.chips[i];
					var label = "⚒ " + c.name;
					var w = ctx.measureText(label).width + 22;
					if (cx + w > maxW - PAD) break;
					ctx.fillStyle = COLORS.bg;
					ctx.strokeStyle = c.status === "error" ? COLORS.err : c.status === "running" ? COLORS.accent : COLORS.line;
					ctx.lineWidth = 1;
					rr(ctx, cx, y, w, 17, 8); ctx.fill(); ctx.stroke();
					ctx.fillStyle = COLORS.tool;
					ctx.fillText(label, cx + 8, y + 12);
					ctx.fillStyle = c.status === "error" ? COLORS.err : c.status === "running" ? COLORS.accent : COLORS.ok;
					ctx.beginPath(); ctx.arc(cx + w - 9, y + 8.5, 2.5, 0, 7); ctx.fill();
					cx += w + 6;
					shown++;
				}
				if (shown < turn.chips.length) {
					ctx.fillStyle = COLORS.dim;
					ctx.fillText("+" + (turn.chips.length - shown), cx + 2, y + 12);
				}
				ctx.restore();
			}

			function drawStrip() {
				var ctx = stripCv.getContext("2d");
				var W = stripCv.width / dpr, H = stripCv.height / dpr;
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, W, H);
				if (!entries.length) return;
				var t0 = entries[0].ms, t1 = entries[entries.length - 1].ms;
				if (t1 <= t0) return;
				var span = t1 - t0;
				var by = H / 2 - 2;
				ctx.fillStyle = COLORS.line;
				ctx.fillRect(PAD, by, W - PAD * 2, 4);
				var step = Math.max(1, Math.floor(entries.length / (W * 2)));
				for (var i = 0; i < entries.length; i += step) {
					var x = PAD + ((entries[i].ms - t0) / span) * (W - PAD * 2);
					var e = entries[i].e;
					var col = COLORS.tool, h = 6;
					if (e.type === "message") {
						var r = e.message && e.message.role;
						if (r === "user") { col = COLORS.warn; h = 12; }
						else if (r === "assistant") { col = COLORS.tool; h = 8; }
						else if (r === "toolResult") { col = e.message.isError ? COLORS.err : COLORS.ok; h = 8; }
					} else if (e.type === "compaction") { col = "#a371f7"; h = 12; }
				else if (e.type === "custom") { col = "#e3b341"; h = 10; }
					ctx.fillStyle = col;
					ctx.fillRect(x - 1, by + 2 - h / 2, 2, h);
				}
				// плейхед
				var px = PAD + ((playheadMs - t0) / span) * (W - PAD * 2);
				px = Math.max(PAD, Math.min(W - PAD, px));
				ctx.fillStyle = COLORS.accent;
				ctx.fillRect(px - 1, 2, 2, H - 4);
				ctx.beginPath(); ctx.moveTo(px - 4, 0); ctx.lineTo(px + 4, 0); ctx.lineTo(px, 6); ctx.closePath(); ctx.fill();
			}

			function seekFromEvent(cv, ev) {
				var rect = cv.getBoundingClientRect();
				var x = ev.clientX - rect.left;
				if (!entries.length) return;
				var t0 = entries[0].ms, t1 = entries[entries.length - 1].ms;
				if (t1 <= t0) return;
				var frac = Math.max(0, Math.min(1, (x - PAD) / (rect.width - PAD * 2)));
				playing = false; el.play.textContent = "▶";
				seekTo(t0 + frac * (t1 - t0));
			}

			stripCv.addEventListener("mousedown", function (ev) {
				seekFromEvent(stripCv, ev);
				var move = function (e2) { seekFromEvent(stripCv, e2); };
				var up = function () { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			});

			// Клик по T# не отматывает плейхед: узел выбирается (кольцо + центрирование
			// в графе), а лента скроллится к его карточке с подсветкой. Плейхед и живой
			// follow сессии не трогаем. Клик мимо узлов — снять выбор.
			graphCv.addEventListener("click", function (ev) {
				var rect = graphCv.getBoundingClientRect();
				var x = ev.clientX - rect.left, y = ev.clientY - rect.top;
				for (var i = 0; i < nodePos.length; i++) {
					var n = nodePos[i];
					if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) {
						selectedTurn = n.turn.index;
						stick = false; // не прыгать в конец на следующем рендере
						draw();
						var card = document.getElementById("t-" + n.turn.index);
						if (card) {
							var top = card.getBoundingClientRect().top - el.tl.getBoundingClientRect().top + el.tl.scrollTop;
							el.tl.scrollTop = Math.max(0, top - el.tl.clientHeight / 2 + card.clientHeight / 2);
						}
						return;
					}
				}
				selectedTurn = -1;
			});

			// Зум колёсиком в графе, dblclick — сброс зума и выбора
			graphCv.addEventListener("wheel", function (ev) {
				ev.preventDefault();
				zoom = Math.max(MIN_Z, Math.min(MAX_Z, zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
				updateZoomInd();
			}, { passive: false });
			graphCv.addEventListener("dblclick", function () {
				zoom = 1; selectedTurn = -1; updateZoomInd();
			});
			function updateZoomInd() {
				var zl = document.getElementById("zoomind");
				if (zl) zl.textContent = Math.round(zoom * 100) + "%";
			}

			(function loop() {
				draw();
				drawStrip();
				requestAnimationFrame(loop);
			})();

			return { resize: resize };
		})();

		draw();
	}

	// ---------- экспорт / node-смоук ----------

	var PiscopeWeb = {
		newModel: newModel, feedEntry: feedEntry,
		parse: function (text) { return String(text).split("\n"); },
		fmtK: fmtK, fmtDur: fmtDur, fmtClock: fmtClock, fmtMoney: fmtMoney,
	};
	globalThis.PiscopeWeb = PiscopeWeb;

	if (typeof document === "undefined") {
		// node: прогон парсера по реальному файлу (session-trace — ESM, import вместо require)
		import("node:fs")
			.then(function (fs) {
				var file = process.argv[2];
				if (!file) {
					console.log("usage: node app.js <session.jsonl>");
					return;
				}
				var m = newModel();
				var n = 0;
				fs.readFileSync(file, "utf8").split("\n").forEach(function (line) {
					var t = line.trim();
					if (!t) return;
					try {
						feedEntry(m, JSON.parse(t));
						n++;
					} catch (e) {
						/* skip */
					}
				});
				var kinds = m.items.reduce(function (acc, it) {
					acc[it.kind] = (acc[it.kind] || 0) + 1;
					return acc;
				}, {});
				console.log("[session-trace web] entries:", n, "items:", JSON.stringify(kinds),
					"totals:", "↑" + fmtK(m.totals.input), "↓" + fmtK(m.totals.output), fmtMoney(m.totals.cost));
			});
		return;
	}
	document.addEventListener("DOMContentLoaded", boot);
})();
