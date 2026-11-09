(function () {
    "use strict";

    // Theme sync lives in theme.js; shared helpers (App.*) in functions.js.

    // ---------- storage ----------
    // History, predefined commands and settings live as JSON files under
    // ~/.cockpit/command-response/, accessed via cockpit.file(). No superuser
    // needed - they're always in the logged-in user's home directory.

    // shell: "" = the default (bash when installed), a path from /etc/shells, or CUSTOM_SHELL.
    var CUSTOM_SHELL = "__custom__";
    var DEFAULT_SETTINGS = { historyDisplayLimit: 100, historyRetentionLimit: 1000, shell: "", customShell: "" };

    var historyFile = null;
    var udFile = null;
    var settingsFile = null;
    var udEntries = [];
    var settings = Object.assign({}, DEFAULT_SETTINGS);
    var editingId = null;

    function storagePaths(home) {
        var dir = home + "/.cockpit/command-response";
        return {
            dir: dir,
            history: dir + "/history",
            userDefined: dir + "/user-defined",
            settings: dir + "/settings",
        };
    }

    // Cockpit promises don't turn thrown exceptions into rejections; wrapping
    // them gives standard Promise semantics and avoids the shell "Ooops!" dialog.
    function native(p) {
        return new Promise(function (resolve, reject) { p.then(resolve, reject); });
    }

    function storageError(action, ex) {
        var detail = (ex && (ex.message || ex.problem)) || String(ex) || "unknown error";
        console.error("Command Response:", action, ex);
        App.alerts.toast("danger", "Storage: could not " + action, { description: detail, timeout: 0 });
    }

    function ensureStorageDir(dir) {
        return native(cockpit.spawn(["mkdir", "-p", dir]));
    }

    function writeFile(file, content, action) {
        if (!file) { storageError(action, "storage not available"); return Promise.resolve(); }
        return native(file.replace(content)).catch(function (ex) { storageError(action, ex); });
    }

    function modifyFile(file, fn, action) {
        if (!file) { storageError(action, "storage not available"); return Promise.resolve(); }
        return native(file.modify(fn)).catch(function (ex) { storageError(action, ex); });
    }

    function persistUserDefined() {
        return writeFile(udFile, udEntries, "save predefined commands");
    }

    function persistSettings() {
        return writeFile(settingsFile, settings, "save settings");
    }

    function persistHistoryEntry(entry) {
        return modifyFile(historyFile, function (old) {
            var arr = Array.isArray(old) ? old.slice() : [];
            arr.push(entry);
            var limit = settings.historyRetentionLimit;
            if (limit > 0 && arr.length > limit) arr = arr.slice(arr.length - limit);
            return arr;
        }, "save history entry");
    }

    function clearPersistedHistory() {
        return writeFile(historyFile, [], "clear history");
    }

    function removeHistoryEntry(id) {
        return modifyFile(historyFile, function (old) {
            return (Array.isArray(old) ? old : []).filter(function (e) { return e.id !== id; });
        }, "remove history entry");
    }

    // ---------- navigation ----------
    // App.menu.mount() handles hash routing and pane visibility; we just
    // declare the structure.

    var MENU = {
        items: [
            { label: "Run", path: "/", pane: "pane-run" },
            {
                label: "Settings", path: "/settings", pane: "pane-settings",
                children: [
                    { label: "Shell", path: "/settings/shell", pane: "pane-shell-settings" },
                    { label: "History Limits", path: "/settings/history", pane: "pane-history-settings" },
                ],
            },
        ],
    };

    // ---------- history cards ----------

    var historyEl = document.getElementById("history");
    var emptyNotice = document.getElementById("history-empty");
    var historyFilterInput = document.getElementById("history-filter");
    var historyNoMatch = document.getElementById("history-no-match");

    function escapeHtml(s) {
        return String(s)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
    }

    function statusClass(status) {
        if (status === "running") return "pf-m-blue";
        if (status === "ok") return "pf-m-green";
        return "pf-m-red";
    }

    function statusText(status, exitStatus) {
        if (status === "running") return "Running…";
        if (status === "ok") return "Exit 0";
        if (typeof exitStatus === "number") return "Exit " + exitStatus;
        return "Failed";
    }

    function badgeHtml(text, cls) {
        return '<span class="pf-v6-c-label ' + cls + ' pf-m-outline ccr-source-badge">' +
                    '<span class="pf-v6-c-label__content">' + text + "</span>" +
                "</span>";
    }

    // badges: [{text, cls}] shown next to the status label (text is trusted markup).
    // entryId links the card to its history-file record.
    function addCard(command, badges, timestampText, extraClass, entryId) {
        var card = document.createElement("div");
        card.className = "pf-v6-c-card ccr-history-card" + (extraClass ? " " + extraClass : "");
        if (entryId) card.dataset.entryId = entryId;
        card.innerHTML =
            '<div class="pf-v6-c-card__header">' +
                '<div class="pf-v6-c-card__header-main">' +
                    '<div class="pf-v6-c-card__title">' +
                        '<code class="pf-v6-c-card__title-text">$ ' + escapeHtml(command) + "</code>" +
                    "</div>" +
                "</div>" +
                '<div class="pf-v6-c-card__actions">' +
                    (badges || []).map(function (b) { return badgeHtml(b.text, b.cls); }).join("") +
                    '<span class="pf-v6-c-label ' + statusClass("running") + ' pf-m-outline status-label ccr-source-badge">' +
                        '<span class="pf-v6-c-label__content">' + statusText("running") + "</span>" +
                    "</span>" +
                    '<button type="button" class="pf-v6-c-button pf-m-plain ccr-wipe-btn" title="Delete this entry">&#128465;</button>' +
                "</div>" +
            "</div>" +
            '<div class="pf-v6-c-card__body">' +
                '<div class="pf-v6-c-code-block">' +
                    '<div class="pf-v6-c-code-block__content ccr-code-block-content">' +
                        '<button type="button" class="pf-v6-c-button pf-m-plain ccr-copy-btn" translate="yes">Copy</button>' +
                        '<pre class="pf-v6-c-code-block__pre"><code class="pf-v6-c-code-block__code output">(running)</code></pre>' +
                    "</div>" +
                "</div>" +
            "</div>" +
            '<div class="pf-v6-c-card__footer app-muted timestamp">' + escapeHtml(timestampText) + "</div>";

        if (emptyNotice) { emptyNotice.remove(); emptyNotice = null; }
        historyEl.insertBefore(card, historyEl.firstChild);

        card.querySelector(".ccr-copy-btn").addEventListener("click", function (e) {
            var btn = e.currentTarget;
            var text = card.querySelector(".output").textContent;
            App.clipboard.copy(text)
                    .then(function () {
                        var orig = btn.textContent;
                        btn.textContent = "Copied!";
                        setTimeout(function () { btn.textContent = orig; }, 1500);
                    })
                    .catch(function (ex) { console.error("Command Response: clipboard write failed:", ex); });
        });

        card.querySelector(".ccr-wipe-btn").addEventListener("click", function () {
            var isIncognito = card.classList.contains("ccr-incognito-card");
            if (isIncognito) {
                card.remove();
                restoreEmptyNotice();
                applyHistoryFilter();
                return;
            }
            App.modals.confirm({
                title: "Delete this history entry?",
                body: "This removes it from ~/.cockpit/command-response/history and cannot be undone.",
                buttons: [
                    {
                        label: "Delete", variant: "danger",
                        action: function (m) {
                            m.close();
                            var id = card.dataset.entryId;
                            card.remove();
                            if (id) removeHistoryEntry(id);
                            restoreEmptyNotice();
                            applyHistoryFilter();
                        },
                    },
                    { label: "Cancel", variant: "link", action: function (m) { m.close(); } },
                ],
                focus: 1,
            });
        });

        return card;
    }

    function paintCard(card, status, output, exitStatus) {
        var label = card.querySelector(".status-label");
        label.className = "pf-v6-c-label " + statusClass(status) + " pf-m-outline status-label ccr-source-badge";
        label.querySelector(".pf-v6-c-label__content").textContent = statusText(status, exitStatus);

        var out = card.querySelector(".output");
        out.textContent = output && output.length ? output : "(no output)";
    }

    function sourceBadge(source) {
        if (source === "manual") return { text: "Manual", cls: "pf-m-blue" };
        return { text: escapeHtml(source.replace(/^UD_/, "Predefined: ")), cls: "pf-m-teal" };
    }

    function trimHistoryOverflow() {
        var cards = historyEl.querySelectorAll(".ccr-history-card");
        var limit = settings.historyDisplayLimit;
        if (limit > 0 && cards.length > limit) {
            for (var i = limit; i < cards.length; i++) cards[i].remove();
        }
    }

    function renderPersistedEntry(entry) {
        var card = addCard(entry.command, [sourceBadge(entry.source)],
                           new Date(entry.ts).toLocaleString(), null, entry.id);
        paintCard(card, entry.ok ? "ok" : "error", entry.output, entry.exit_status);
    }

    function restoreEmptyNotice() {
        if (!emptyNotice && historyEl.children.length === 0) {
            emptyNotice = document.createElement("p");
            emptyNotice.id = "history-empty";
            emptyNotice.className = "app-muted";
            emptyNotice.setAttribute("translate", "yes");
            emptyNotice.textContent = "No commands run yet.";
            historyEl.appendChild(emptyNotice);
        }
    }

    function applyHistoryFilter() {
        var query = historyFilterInput.value.trim().toLowerCase();
        var cards = historyEl.querySelectorAll(".ccr-history-card");
        var anyVisible = false;
        cards.forEach(function (card) {
            var haystack = (card.querySelector(".pf-v6-c-card__title-text").textContent + " " +
                            card.querySelector(".output").textContent).toLowerCase();
            var matches = !query || haystack.indexOf(query) !== -1;
            card.hidden = !matches;
            if (matches) anyVisible = true;
        });
        historyNoMatch.hidden = !(query && cards.length > 0 && !anyVisible);
    }

    historyFilterInput.addEventListener("input", applyHistoryFilter);

    function reloadHistoryDisplay() {
        return native(historyFile.read()).then(function (entries) {
            if (!Array.isArray(entries)) entries = [];
            historyEl.innerHTML = "";
            emptyNotice = null;
            var limit = settings.historyDisplayLimit;
            entries.slice(limit > 0 ? -limit : 0).forEach(renderPersistedEntry);
            restoreEmptyNotice();
            applyHistoryFilter();
        }).catch(function (ex) { storageError("reload history", ex); });
    }

    // ---------- shell ----------
    // Commands run as `<shell> -c <command>`. The shell is a setting: any
    // executable listed in /etc/shells, or a custom program (+ arguments).

    var shellForm = document.getElementById("shell-form");
    var shellSelect = document.getElementById("shell-select");
    var shellCustomGroup = document.getElementById("shell-custom-group");
    var shellCustomInput = document.getElementById("shell-custom-input");
    var shellNote = document.getElementById("shell-note");
    var shellSaveBtn = document.getElementById("shell-save-btn");
    var shellFooter = document.getElementById("shell-footer");
    var availableShells = [];

    function baseName(path) {
        return path.split("/").pop();
    }

    // Installed login shells. Entries that are symlinks to the same binary
    // (/bin/bash and /usr/bin/bash) are listed once; nologin/false/true are dropped.
    function detectShells() {
        var script = 'if [ -r /etc/shells ]; then grep -E "^/" /etc/shells; fi | ' +
                     'while read -r s; do [ -x "$s" ] || continue; ' +
                     'r=$(readlink -f "$s" 2>/dev/null || echo "$s"); echo "$r $s"; done';
        return native(cockpit.spawn(["sh", "-c", script], { err: "message" })).then(function (out) {
            var seen = {};
            var list = [];
            out.split("\n").forEach(function (line) {
                var parts = line.trim().split(/\s+/);
                if (parts.length !== 2) return;
                var real = parts[0];
                var path = parts[1];
                if (["nologin", "false", "true"].indexOf(baseName(path)) !== -1) return;
                // Busybox-style links share one binary but behave differently by name.
                var key = baseName(real) === baseName(path) ? real : path;
                if (seen[key]) return;
                seen[key] = true;
                list.push(path);
            });
            return list;
        }).catch(function (ex) {
            console.error("Command Response: could not read /etc/shells:", ex);
            return [];
        }).then(function (list) {
            availableShells = list;
        });
    }

    function defaultShell() {
        var bash = availableShells.find(function (s) { return baseName(s) === "bash"; });
        return bash || availableShells[0] || "bash";
    }

    function customArgv() {
        return (settings.customShell || "").trim().split(/\s+/).filter(Boolean);
    }

    // The program (+ arguments) that runs commands, from the saved setting.
    // A saved path that is no longer installed falls back to the default.
    function shellArgv() {
        if (settings.shell === CUSTOM_SHELL && customArgv().length) return customArgv();
        if (settings.shell && settings.shell !== CUSTOM_SHELL && availableShells.indexOf(settings.shell) !== -1)
            return [settings.shell];
        return [defaultShell()];
    }

    function updateShellFooter() {
        shellFooter.textContent = "Commands run with: " + shellArgv().join(" ") + " -c";
    }

    function renderShellForm() {
        var chosen = settings.shell;
        var usable = chosen === CUSTOM_SHELL || availableShells.indexOf(chosen) !== -1;
        shellSelect.innerHTML = "";
        availableShells.forEach(function (path) {
            var opt = document.createElement("option");
            opt.value = path;
            opt.textContent = path;
            shellSelect.appendChild(opt);
        });
        var custom = document.createElement("option");
        custom.value = CUSTOM_SHELL;
        custom.textContent = "Custom…";
        shellSelect.appendChild(custom);

        shellSelect.value = usable ? chosen : (availableShells.indexOf(defaultShell()) !== -1 ? defaultShell() : CUSTOM_SHELL);
        shellCustomInput.value = settings.customShell || "";
        shellCustomGroup.hidden = shellSelect.value !== CUSTOM_SHELL;
        shellNote.textContent = chosen && !usable
            ? 'The saved shell "' + chosen + '" is not installed here; using ' + defaultShell() + " instead."
            : "";
        updateShellFooter();
    }

    shellSelect.addEventListener("change", function () {
        shellCustomGroup.hidden = shellSelect.value !== CUSTOM_SHELL;
        if (!shellCustomGroup.hidden) shellCustomInput.focus();
    });

    shellForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var choice = shellSelect.value;

        function save() {
            settings.shell = choice;
            if (choice === CUSTOM_SHELL) settings.customShell = shellCustomInput.value.trim();
            return persistSettings().then(function () {
                renderShellForm();
                App.alerts.toast("success", "Shell saved", { description: "Commands now run with " + shellArgv().join(" ") + " -c" });
            });
        }

        if (choice !== CUSTOM_SHELL) { save(); return; }

        var argv = shellCustomInput.value.trim().split(/\s+/).filter(Boolean);
        if (!argv.length) {
            App.alerts.toast("warning", "Enter a program for the custom shell.");
            return;
        }
        shellSaveBtn.disabled = true;
        // Refuse a program that cannot be found, so every run doesn't fail afterwards.
        native(cockpit.spawn(["sh", "-c", 'command -v -- "$1" >/dev/null', "sh", argv[0]], { err: "message" }))
                .then(save, function () {
                    App.alerts.toast("danger", "Shell not found", { description: '"' + argv[0] + '" is not an executable on this machine.' });
                })
                .then(function () { shellSaveBtn.disabled = false; });
    });

    // ---------- run command ----------
    // err:"out" merges stderr into the output block shown in the card.

    function runCommand(command, opts) {
        var badges = [sourceBadge(opts.source)];
        if (opts.incognito) badges.push({ text: "&#128465; Incognito", cls: "pf-m-purple" });

        var entryId = App.uuid.v4();
        var card = addCard(command, badges, new Date().toLocaleString(),
                           opts.incognito ? "ccr-incognito-card" : null, entryId);

        native(cockpit.spawn(shellArgv().concat(["-c", command]), { err: "out", superuser: "try" }))
                .then(function (data) {
                    paintCard(card, "ok", data, 0);
                    if (!opts.incognito) {
                        persistHistoryEntry({ id: entryId, ts: new Date().toISOString(),
                            source: opts.source, command: command, ok: true, exit_status: 0, output: data });
                        trimHistoryOverflow();
                    }
                    applyHistoryFilter();
                }, function (ex) {
                    var output = (ex && ex.message) || (ex && ex.toString()) || "";
                    console.error("Command Response: command failed:", ex);
                    paintCard(card, "error", output, ex ? ex.exit_status : undefined);
                    if (!opts.incognito) {
                        persistHistoryEntry({ id: entryId, ts: new Date().toISOString(),
                            source: opts.source, command: command, ok: false,
                            exit_status: ex ? ex.exit_status : undefined, output: output });
                        trimHistoryOverflow();
                    }
                    applyHistoryFilter();
                });
    }

    // ---------- run pane ----------

    var commandForm = document.getElementById("command-form");
    var commandInput = document.getElementById("command-input");
    var incognitoBtn = document.getElementById("incognito-btn");
    var clearBtn = document.getElementById("clear-btn");
    var predefinedSection = document.getElementById("predefined-section");
    var predefinedSelect = document.getElementById("predefined-select");
    var predefinedRunBtn = document.getElementById("predefined-run-btn");
    var predefinedIncognitoBtn = document.getElementById("predefined-incognito-btn");

    function renderPredefinedSection() {
        predefinedSection.hidden = udEntries.length === 0;
        predefinedSelect.innerHTML = "";
        udEntries.forEach(function (entry) {
            var opt = document.createElement("option");
            opt.value = entry.id;
            opt.textContent = entry.name;
            predefinedSelect.appendChild(opt);
        });
    }

    function selectedPredefinedEntry() {
        var id = predefinedSelect.value;
        return udEntries.find(function (e) { return e.id === id; }) || null;
    }

    commandForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var command = commandInput.value.trim();
        if (!command) return;
        runCommand(command, { source: "manual" });
        commandInput.value = "";
        commandInput.focus();
    });

    incognitoBtn.addEventListener("click", function () {
        var command = commandInput.value.trim();
        if (!command) return;
        runCommand(command, { source: "manual", incognito: true });
        commandInput.value = "";
        commandInput.focus();
    });

    predefinedRunBtn.addEventListener("click", function () {
        var entry = selectedPredefinedEntry();
        if (!entry) return;
        runCommand(entry.command, { source: "UD_" + entry.name });
    });

    predefinedIncognitoBtn.addEventListener("click", function () {
        var entry = selectedPredefinedEntry();
        if (!entry) return;
        runCommand(entry.command, { source: "UD_" + entry.name, incognito: true });
    });

    clearBtn.addEventListener("click", function () {
        App.modals.confirm({
            title: "Clear saved history?",
            body: "This removes all entries from ~/.cockpit/command-response/history and cannot be undone.",
            buttons: [
                {
                    label: "Clear History", variant: "danger",
                    action: function (m) {
                        m.close();
                        historyEl.innerHTML = "";
                        emptyNotice = null;
                        restoreEmptyNotice();
                        clearPersistedHistory();
                    },
                },
                { label: "Cancel", variant: "link", action: function (m) { m.close(); } },
            ],
            focus: 1,
        });
    });

    // ---------- settings pane: predefined commands ----------

    var manageForm = document.getElementById("manage-form");
    var manageNameInput = document.getElementById("manage-name-input");
    var manageCommandInput = document.getElementById("manage-command-input");
    var manageSaveBtn = document.getElementById("manage-save-btn");
    var manageCancelBtn = document.getElementById("manage-cancel-btn");
    var manageFormTitle = document.getElementById("manage-form-title");
    var manageList = document.getElementById("manage-list");
    var manageEmpty = document.getElementById("manage-empty");

    function renderManageList() {
        manageList.innerHTML = "";
        manageEmpty.hidden = udEntries.length !== 0;
        udEntries.forEach(function (entry, index) {
            var item = document.createElement("div");
            item.className = "pf-v6-c-data-list__item";
            item.innerHTML =
                '<div class="pf-v6-c-data-list__item-row">' +
                    '<div class="pf-v6-c-data-list__item-content">' +
                        '<div class="pf-v6-c-data-list__cell"><strong>' + escapeHtml(entry.name) + "</strong></div>" +
                        '<div class="pf-v6-c-data-list__cell"><code>' + escapeHtml(entry.command) + "</code></div>" +
                    "</div>" +
                    '<div class="pf-v6-c-data-list__item-action">' +
                        '<button type="button" class="pf-v6-c-button pf-m-plain" data-action="up"' +
                            (index === 0 ? " disabled" : "") + '>&uarr;</button>' +
                        '<button type="button" class="pf-v6-c-button pf-m-plain" data-action="down"' +
                            (index === udEntries.length - 1 ? " disabled" : "") + '>&darr;</button>' +
                        '<button type="button" class="pf-v6-c-button pf-m-secondary" data-action="edit" translate="yes">Edit</button>' +
                        '<button type="button" class="pf-v6-c-button pf-m-danger" data-action="delete" translate="yes">Delete</button>' +
                    "</div>" +
                "</div>";
            item.dataset.id = entry.id;
            manageList.appendChild(item);
        });
    }

    function resetManageForm() {
        editingId = null;
        manageNameInput.value = "";
        manageCommandInput.value = "";
        manageFormTitle.textContent = "Add a predefined command";
        manageSaveBtn.textContent = "Add";
        manageCancelBtn.hidden = true;
    }

    manageForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = manageNameInput.value.trim();
        var command = manageCommandInput.value.trim();
        if (!name || !command) {
            App.alerts.toast("warning", "Both a name and a command are required.");
            return;
        }
        if (editingId) {
            var entry = udEntries.find(function (en) { return en.id === editingId; });
            if (entry) { entry.name = name; entry.command = command; }
        } else {
            udEntries.push({ id: App.uuid.v4(), name: name, command: command });
        }
        persistUserDefined();
        renderManageList();
        renderPredefinedSection();
        resetManageForm();
    });

    manageCancelBtn.addEventListener("click", resetManageForm);

    function moveEntry(id, direction) {
        var index = udEntries.findIndex(function (en) { return en.id === id; });
        if (index === -1) return;
        var neighborIndex = direction === "up" ? index - 1 : index + 1;
        if (neighborIndex < 0 || neighborIndex >= udEntries.length) return;
        var entry = udEntries[index];
        udEntries[index] = udEntries[neighborIndex];
        udEntries[neighborIndex] = entry;
        persistUserDefined();
        renderManageList();
        renderPredefinedSection();
    }

    manageList.addEventListener("click", function (e) {
        var button = e.target.closest("button[data-action]");
        if (!button) return;
        var item = e.target.closest(".pf-v6-c-data-list__item");
        var id = item.dataset.id;
        var action = button.dataset.action;

        if (action === "up" || action === "down") {
            moveEntry(id, action);
        } else if (action === "edit") {
            var entry = udEntries.find(function (en) { return en.id === id; });
            if (!entry) return;
            editingId = id;
            manageNameInput.value = entry.name;
            manageCommandInput.value = entry.command;
            manageFormTitle.textContent = "Edit predefined command";
            manageSaveBtn.textContent = "Save Changes";
            manageCancelBtn.hidden = false;
            manageNameInput.focus();
        } else if (action === "delete") {
            var toDelete = udEntries.find(function (en) { return en.id === id; });
            if (!toDelete) return;
            App.modals.confirm({
                title: 'Delete "' + toDelete.name + '"?',
                body: "This predefined command will be permanently removed.",
                buttons: [
                    {
                        label: "Delete", variant: "danger",
                        action: function (m) {
                            m.close();
                            udEntries = udEntries.filter(function (en) { return en.id !== id; });
                            if (editingId === id) resetManageForm();
                            persistUserDefined();
                            renderManageList();
                            renderPredefinedSection();
                        },
                    },
                    { label: "Cancel", variant: "link", action: function (m) { m.close(); } },
                ],
                focus: 1,
            });
        }
    });

    // ---------- startup ----------

    function readOrSeed(file, fallback, isValid) {
        return native(file.read()).catch(function (ex) {
            console.error("Command Response: unreadable storage file, resetting:", ex);
            return null;
        }).then(function (content) {
            if (content !== null && content !== undefined && isValid(content)) return content;
            return writeFile(file, fallback, "create storage file").then(function () { return fallback; });
        });
    }

    function isPlainObject(v) {
        return v !== null && typeof v === "object" && !Array.isArray(v);
    }

    native(cockpit.user()).then(function (user) {
        var paths = storagePaths(user.home);
        historyFile = cockpit.file(paths.history, { syntax: JSON });
        udFile = cockpit.file(paths.userDefined, { syntax: JSON });
        settingsFile = cockpit.file(paths.settings, { syntax: JSON });
        return ensureStorageDir(paths.dir).then(function () {
            return Promise.all([
                readOrSeed(udFile, [], Array.isArray),
                readOrSeed(historyFile, [], Array.isArray),
                readOrSeed(settingsFile, Object.assign({}, DEFAULT_SETTINGS), isPlainObject),
            ]);
        });
    }).then(function (results) {
        udEntries = results[0];
        var historyEntries = results[1];
        settings = Object.assign({}, DEFAULT_SETTINGS, results[2]);
        if (!(settings.historyDisplayLimit > 0)) settings.historyDisplayLimit = DEFAULT_SETTINGS.historyDisplayLimit;
        if (!(settings.historyRetentionLimit > 0)) settings.historyRetentionLimit = DEFAULT_SETTINGS.historyRetentionLimit;

        renderPredefinedSection();
        renderManageList();
        updateShellFooter();
        // Detection is async; until it lands, runs fall back to plain "bash".
        detectShells().then(renderShellForm);

        App.settings.form({
            container: "history-settings-container",
            fields: [
                { key: "historyDisplayLimit", label: "Show at most this many recent entries in History", type: "number" },
                { key: "historyRetentionLimit", label: "Keep at most this many entries in the history file", type: "number",
                  help: "Older entries beyond this count are pruned automatically each time a command runs." },
            ],
            load: function () { return Object.assign({}, settings); },
            save: function (values) {
                var displayLimit = Number(values.historyDisplayLimit);
                var retentionLimit = Number(values.historyRetentionLimit);
                if (!(displayLimit > 0) || !(retentionLimit > 0))
                    return Promise.reject(new Error("Both values must be positive numbers."));
                settings.historyDisplayLimit = displayLimit;
                settings.historyRetentionLimit = retentionLimit;
                return persistSettings().then(reloadHistoryDisplay);
            },
            notice: false,
        });

        var toShow = historyEntries.slice(settings.historyDisplayLimit > 0 ? -settings.historyDisplayLimit : 0);
        toShow.forEach(renderPersistedEntry);
        restoreEmptyNotice();
    }).catch(function (ex) {
        storageError("initialize storage", ex);
        restoreEmptyNotice();
    });

    App.menu.mount(MENU, { nav: "app-menu", startExpanded: true });
}());
