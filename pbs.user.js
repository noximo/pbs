// ==UserScript==
// @name         PBS
// @namespace    https://github.com/noximo/pbs
// @version      0.3.18
// @description  Add project name as query param and redirect
// @match        https://pbs2.praguebest.cz/*
// @updateURL    https://raw.githubusercontent.com/noximo/pbs/main/pbs.user.js
// @downloadURL  https://raw.githubusercontent.com/noximo/pbs/main/pbs.user.js
// @grant        none
// ==/UserScript==

(function() {
    const translitMap = {
        'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e',
        'í': 'i', 'ň': 'n', 'ó': 'o', 'ř': 'r', 'š': 's',
        'ť': 't', 'ů': 'u', 'ú': 'u', 'ý': 'y', 'ž': 'z',
        'Á': 'a', 'Č': 'c', 'Ď': 'd', 'É': 'e', 'Ě': 'e',
        'Í': 'i', 'Ň': 'n', 'Ó': 'o', 'Ř': 'r', 'Š': 's',
        'Ť': 't', 'Ů': 'u', 'Ú': 'u', 'Ý': 'y', 'Ž': 'z'
    };

    const systemCommentPatterns = [
        /^Přidáno:/,
        /^Změna času spolupracovníka/,
        /^Uživatel požádal o čas/,
        /^Změna autora/,
        /^Předáno:/
    ];
    const checkingTaskIds = new Set();
    const taskCheckErrors = new Map();
    const POST_MARKER_KEY = 'PBS_pending_post';
    const STARRED_TASKS_KEY = 'PBS_starred_tasks';
    const TASK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
    const TASK_CHECK_TIMEOUT_MS = 15 * 1000;
    const MAX_VISITED_TASKS = 200;

    function normalizeText(value) {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    function isSystemCommentContent(content) {
        const text = normalizeText(
            typeof content === 'string' ? content.replace(/<[^>]*>/g, ' ') : content?.textContent
        );
        return systemCommentPatterns.some(pattern => pattern.test(text));
    }

    function checkPostRequest() {
        const timestamp = Number(safeGetStorageItem(POST_MARKER_KEY, sessionStorage) || 0);
        safeRemoveStorageItem(POST_MARKER_KEY, sessionStorage);
        const navigation = performance.getEntriesByType('navigation')[0];
        const wasRedirected = Number(navigation?.redirectCount || 0) > 0;
        return !wasRedirected && timestamp > 0 && Date.now() - timestamp < 30 * 1000;
    }

    function trackPostSubmissions() {
        document.addEventListener('submit', event => {
            const form = event.target;
            if (!(form instanceof HTMLFormElement)) return;
            const method = (form.getAttribute('method') || 'get').toLowerCase();
            if (method === 'post') {
                safeSetStorageItem(POST_MARKER_KEY, String(Date.now()), sessionStorage);
            }
        }, true);
    }

    function isTaskDetailUrl() {
        const url = new URL(window.location.href);
        return url.pathname === '/main.php'
            && url.searchParams.get('action') === 'detail'
            && Boolean(url.searchParams.get('id'));
    }

    function handlePathRedirect() {
        const pathParts = window.location.pathname
            .split('/')
            .filter(Boolean)
            .map(part => {
                try {
                    return decodeURIComponent(part);
                } catch (error) {
                    return part;
                }
            });
        if (pathParts.length === 3 && /^\d+$/.test(pathParts[2])) {
            const redirectUrl = buildParamUrl(pathParts[1], pathParts[2], pathParts[0]);
            window.location = redirectUrl;
            return true;
        }
        return false;
    }

    function createSlug(str) {
        return str
            .replace(/[áčďéěíňóřšťůúýžÁČĎÉĚÍŇÓŘŠŤŮÚÝŽ]/g, c => translitMap[c] || c)
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\p{L}\p{N}_-]/gu, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    function buildTValue(client, nameSlug) {
        const clientSlug = client ? createSlug(client) : '';
        const parts = [];
        if (clientSlug) parts.push(clientSlug.toUpperCase());
        if (nameSlug) parts.push(nameSlug);
        return parts.join('-');
    }

    function buildParamUrl(nameSlug, id, client) {
        const tValue = buildTValue(client, nameSlug);
        const url = new URL('/main.php', window.location.origin);
        url.searchParams.set('action', 'detail');
        url.searchParams.set('id', String(id));
        url.searchParams.set('t', tValue);
        return url.href;
    }

    function findTaskDetailTable(doc = document) {
        return Array.from(doc.querySelectorAll('table.itable')).find(table => {
            const labels = Array.from(table.querySelectorAll('tr th')).map(th => normalizeText(th.textContent));
            return labels.includes('ID:') && labels.some(label => label.includes('Název:'));
        }) || null;
    }

    function findExtendedTaskDetailForm(doc = document) {
        const form = doc.querySelector('form#editTaskForm, form[name="editForm"]');
        if (!form) return null;

        const labels = Array.from(form.querySelectorAll('label')).map(label => normalizeText(label.textContent));
        return labels.some(label => label === 'ID úkolu:')
            && labels.some(label => label === 'Název:')
            ? form
            : null;
    }

    function getExtendedTaskField(form, labelText) {
        const label = Array.from(form.querySelectorAll('label')).find(
            candidate => normalizeText(candidate.textContent) === labelText
        );
        return label?.nextElementSibling || null;
    }

    function extractExtendedTaskData(form) {
        const idField = getExtendedTaskField(form, 'ID úkolu:');
        const nameField = getExtendedTaskField(form, 'Název:');
        const clientField = getExtendedTaskField(form, 'Zákazník:');
        const statusField = getExtendedTaskField(form, 'Status:');
        const status = normalizeText(statusField?.textContent);

        return {
            name: normalizeText(nameField?.textContent),
            id: normalizeText(idField?.textContent),
            client: normalizeText(clientField?.querySelector(':scope > strong')?.textContent || clientField?.textContent),
            status,
            completed: status.toLocaleLowerCase('cs').includes('ukončený')
        };
    }

    function extractTableData(doc = document, hideTable = true) {
        const table = findTaskDetailTable(doc);
        if (!table) {
            const form = findExtendedTaskDetailForm(doc);
            if (!form) return null;

            const data = extractExtendedTaskData(form);
            return data.name && data.id ? data : null;
        }

        const data = { name: '', id: '', client: '', status: '', completed: false };
        const rows = table.querySelectorAll('tbody tr');

        for (const row of rows) {
            for (const th of row.querySelectorAll('th')) {
                const valueCell = th.nextElementSibling;
                if (!valueCell || !/^(TH|TD)$/.test(valueCell.tagName)) continue;

                const label = normalizeText(th.textContent);
                const value = normalizeText(valueCell.textContent);
                if (label.includes('Název:')) data.name = value;
                if (label === 'ID:') data.id = value;
                if (label.includes('Zákazník:')) data.client = value;
                if (label.toLocaleLowerCase('cs') === 'status:') {
                    data.status = value;
                    data.completed = value.toLocaleLowerCase('cs').includes('ukončený');
                }
            }
        }

        if (!data.name || !data.id) return null;
        if (hideTable) table.style.display = 'none';
        return data;
    }

    function safeGetStorageItem(key, storage = localStorage) {
        try {
            return storage.getItem(key);
        } catch (error) {
            console.warn(`PBS: storage read failed for ${key}`, error);
            return null;
        }
    }

    function safeSetStorageItem(key, value, storage = localStorage) {
        try {
            storage.setItem(key, value);
            return true;
        } catch (error) {
            console.warn(`PBS: storage write failed for ${key}`, error);
            showPbsMessage('Nastavení se nepodařilo uložit. Zkontrolujte volné místo prohlížeče.', true);
            return false;
        }
    }

    function safeRemoveStorageItem(key, storage = localStorage) {
        try {
            storage.removeItem(key);
        } catch (error) {
            console.warn(`PBS: storage removal failed for ${key}`, error);
        }
    }

    function readStarredTasks() {
        const stored = safeGetStorageItem(STARRED_TASKS_KEY);
        if (!stored) return [];
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed)
                ? parsed.filter(task => task && typeof task === 'object')
                : [];
        } catch (e) {
            return [];
        }
    }

    const VISITED_TASKS_KEY = 'PBS_visited_tasks';
    const CUSTOM_TASK_NAMES_KEY = 'PBS_custom_task_names';

    function writeStarredTasks(tasks) {
        safeSetStorageItem(STARRED_TASKS_KEY, JSON.stringify(tasks));
    }

    function readVisitedTasks() {
        const stored = safeGetStorageItem(VISITED_TASKS_KEY);
        if (!stored) return [];
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed)
                ? parsed.filter(task => task && typeof task === 'object')
                : [];
        } catch (e) {
            return [];
        }
    }

    function writeVisitedTasks(tasks) {
        const uniqueTasks = new Map();
        [...tasks]
            .sort((a, b) => Number(b.lastVisitedAt || 0) - Number(a.lastVisitedAt || 0))
            .forEach(task => {
                const key = String(task.id || task.url || '');
                if (key && !uniqueTasks.has(key)) uniqueTasks.set(key, task);
            });
        safeSetStorageItem(
            VISITED_TASKS_KEY,
            JSON.stringify(Array.from(uniqueTasks.values()).slice(0, MAX_VISITED_TASKS))
        );
    }

    function readCustomTaskNames() {
        const stored = safeGetStorageItem(CUSTOM_TASK_NAMES_KEY);
        if (!stored) return {};
        try {
            const parsed = JSON.parse(stored);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function getCustomTaskName(id) {
        if (!id) return '';
        const value = readCustomTaskNames()[String(id)];
        return typeof value === 'string' ? value.trim() : '';
    }

    function writeCustomTaskName(id, name) {
        if (!id) return;
        const names = readCustomTaskNames();
        const trimmedName = (name || '').trim();
        if (trimmedName) {
            names[String(id)] = trimmedName;
        } else {
            delete names[String(id)];
        }
        safeSetStorageItem(CUSTOM_TASK_NAMES_KEY, JSON.stringify(names));
    }

    function getTaskDisplayName(task) {
        return getCustomTaskName(task?.id) || task?.name || '';
    }

    function getTaskUrl(task) {
        const displayName = getTaskDisplayName(task);
        if (!task?.id || !displayName) return task?.url || '';
        return buildParamUrl(createSlug(displayName), task.id, task.client);
    }

    function updateStoredTaskName(id, originalName, client) {
        if (!id) return;
        const displayName = getCustomTaskName(id) || originalName;
        const url = buildParamUrl(createSlug(displayName), id, client);

        const updateTasks = (readTasks, writeTasks) => {
            const tasks = readTasks();
            let changed = false;
            tasks.forEach(task => {
                if (String(task.id) !== String(id)) return;
                task.name = displayName;
                task.originalName = originalName;
                task.client = client;
                task.url = url;
                changed = true;
            });
            if (changed) writeTasks(tasks);
        };

        updateTasks(readStarredTasks, writeStarredTasks);
        updateTasks(readVisitedTasks, writeVisitedTasks);
    }

    function showPbsMessage(message, isError = false) {
        if (!document.body) return;
        let messageBox = document.getElementById('pbs-message');
        if (!messageBox) {
            messageBox = document.createElement('div');
            messageBox.id = 'pbs-message';
            messageBox.setAttribute('role', 'status');
            messageBox.setAttribute('aria-live', 'polite');
            messageBox.style.cssText = [
                'position: fixed',
                'inset-inline-end: 16px',
                'inset-block-start: 72px',
                'z-index: 10000',
                'max-width: min(360px, calc(100vw - 32px))',
                'padding: 10px 12px',
                'border-radius: 6px',
                'box-shadow: 0 6px 18px rgba(0,0,0,0.18)',
                'font-size: 13px',
                'line-height: 1.4'
            ].join(';');
            document.body.appendChild(messageBox);
        }

        messageBox.style.background = isError ? '#7d1a12' : '#243429';
        messageBox.style.color = '#fff';
        messageBox.textContent = message;
        messageBox.hidden = false;
        window.clearTimeout(showPbsMessage.timeoutId);
        showPbsMessage.timeoutId = window.setTimeout(() => {
            messageBox.hidden = true;
        }, isError ? 5000 : 2500);
    }

    function ensurePbsStyles() {
        if (document.getElementById('pbs-userscript-styles')) return;
        const style = document.createElement('style');
        style.id = 'pbs-userscript-styles';
        style.textContent = `
            .pbs-control:focus-visible,
            #pbs-star-toggle:focus-visible {
                outline: 2px solid #9f1607;
                outline-offset: 2px;
            }
            #pbs-starred-panel a:focus-visible {
                outline: 2px solid #9f1607;
                outline-offset: 2px;
                border-radius: 2px;
            }
            #pbs-starred-panel {
                scrollbar-width: thin;
                scrollbar-color: rgba(0, 0, 0, 0.28) transparent;
            }
            #pbs-starred-panel::-webkit-scrollbar {
                width: 8px;
            }
            #pbs-starred-panel::-webkit-scrollbar-thumb {
                background: rgba(0, 0, 0, 0.24);
                border: 2px solid transparent;
                border-radius: 999px;
                background-clip: content-box;
            }
            #pbs-starred-panel::-webkit-scrollbar-thumb:hover {
                background-color: rgba(0, 0, 0, 0.4);
            }
            @media (min-width: 761px) and (max-width: 1320px) and (hover: hover) and (pointer: fine) {
                #pbs-starred-panel {
                    transform: translateX(calc(-100% + 28px));
                    transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1);
                }
                #pbs-starred-panel:hover,
                #pbs-starred-panel:focus-within {
                    transform: translateX(0);
                }
                #pbs-starred-panel::after {
                    content: '›';
                    position: absolute;
                    inset-inline-end: 7px;
                    inset-block-start: 50%;
                    color: rgba(0, 0, 0, 0.42);
                    font-size: 21px;
                    line-height: 1;
                    pointer-events: none;
                    transform: translateY(-50%);
                    transition: opacity 0.15s ease-out;
                }
                #pbs-starred-panel:hover::after,
                #pbs-starred-panel:focus-within::after {
                    opacity: 0;
                }
            }
            @media (max-width: 760px) {
                #pbs-starred-panel {
                    width: 100vw !important;
                    font-size: 14px !important;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function getTaskActivityTime(task) {
        return Math.max(
            Number(task?.lastVisitedAt || getLastVisitTimeForTask(task) || 0),
            Number(task?.lastPostTime || 0)
        );
    }

    function getClientBadgeColors(clientName) {
        const hash = Array.from(clientName).reduce(
            (value, character) => ((value << 5) - value + character.charCodeAt(0)) | 0,
            0
        );
        const hue = Math.abs(hash) % 360;
        return {
            background: `hsl(${hue} 72% 92%)`,
            color: `hsl(${hue} 56% 25%)`
        };
    }

    function ensureTaskPreviewTooltip() {
        let tooltip = document.getElementById('pbs-task-preview-tooltip');
        if (tooltip) return tooltip;

        tooltip = document.createElement('div');
        tooltip.id = 'pbs-task-preview-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.style.cssText = [
            'position: fixed',
            'z-index: 1001',
            'box-sizing: border-box',
            'width: min(380px, calc(100vw - 24px))',
            'max-height: min(70vh, 560px)',
            'overflow-y: auto',
            'padding: 10px 12px',
            'background: #fff',
            'border: 1px solid #d8d8d8',
            'border-radius: 8px',
            'box-shadow: 0 8px 24px rgba(0,0,0,0.16)',
            'color: #333',
            'font-size: 13px',
            'line-height: 1.5',
            'white-space: pre-wrap',
            'overflow-wrap: anywhere',
            'text-align: start',
            'pointer-events: none',
            'opacity: 0',
            'visibility: hidden',
            'transition: opacity 0.15s ease-out'
        ].join(';');
        document.body.appendChild(tooltip);
        return tooltip;
    }

    function showTaskPreviewTooltip(target, text) {
        if (!text) return;
        const tooltip = ensureTaskPreviewTooltip();
        const targetRect = target.getBoundingClientRect();
        const gap = 12;
        const preferredLeft = targetRect.right + gap;
        const canOpenRight = preferredLeft + 220 <= window.innerWidth;
        tooltip.textContent = text;
        tooltip.style.left = `${canOpenRight ? preferredLeft : 12}px`;
        tooltip.style.top = '12px';
        tooltip.style.visibility = 'visible';
        tooltip.style.opacity = '1';
        const maxTop = window.innerHeight - tooltip.offsetHeight - 12;
        const preferredTop = canOpenRight ? targetRect.top : targetRect.bottom + gap;
        tooltip.style.top = `${Math.max(12, Math.min(preferredTop, maxTop))}px`;
    }

    function hideTaskPreviewTooltip() {
        const tooltip = document.getElementById('pbs-task-preview-tooltip');
        if (!tooltip) return;
        tooltip.style.opacity = '0';
        tooltip.style.visibility = 'hidden';
    }

    function ensureStarredTasksPanel() {
        let panel = document.getElementById('pbs-starred-panel');
        if (panel) return panel;
        ensurePbsStyles();

        panel = document.createElement('div');
        panel.id = 'pbs-starred-panel';
        panel.setAttribute('aria-label', 'Přehled úkolů');
        panel.setAttribute('role', 'complementary');
        panel.style.cssText = [
            'position: fixed',
            'inset-inline-start: 0',
            'inset-block-end: 0',
            'z-index: 999',
            'width: 300px',
            'box-sizing: border-box',
            'background: #fff',
            'border-inline-end: 1px solid #ddd',
            'padding: 12px',
            'text-align: left',
            'line-height: 1.5em',
            'font-size: 13px',
            'overflow: auto'
        ].join(';');

        const list = document.createElement('div');
        list.id = 'pbs-starred-list';
        list.style.cssText = 'transition:transform 0.3s cubic-bezier(0.16, 1, 0.3, 1); will-change:transform;';
        panel.appendChild(list);

        document.body.prepend(panel);
        return panel;
    }

    function getLastVisitTimeForTask(task) {
        if (!task?.id) return 0;
        const value = safeGetStorageItem(`PBS_lastVisit_${task.id}`);
        return value ? parseInt(value, 10) || 0 : 0;
    }

    function getInboxTasks() {
        const starredTasks = readStarredTasks()
            .map(task => ({
                ...task,
                lastVisitedAt: Number(task.lastVisitedAt || getLastVisitTimeForTask(task) || 0)
            }))
            .sort((a, b) => getTaskActivityTime(b) - getTaskActivityTime(a));
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        const cutoffTime = now - weekMs;
        const starredIds = new Set(starredTasks.map(task => String(task.id || '')));
        const recentVisited = readVisitedTasks()
            .map(task => ({
                ...task,
                lastVisitedAt: Number(task.lastVisitedAt || getLastVisitTimeForTask(task) || 0)
            }))
            .filter(task => task.lastVisitedAt >= cutoffTime)
            .sort((a, b) => getTaskActivityTime(b) - getTaskActivityTime(a));

        const nonStarredVisited = recentVisited
            .filter(task => !starredIds.has(String(task.id || '')))
            .slice(0, 15);

        return [...starredTasks, ...nonStarredVisited];
    }

    function setInboxPanelHeaderVisibility(panel, headerHeight, headerHidden) {
        panel.dataset.headerHidden = String(headerHidden);
        panel.style.insetBlockStart = '0px';
        const list = panel.querySelector('#pbs-starred-list');
        if (list) list.style.transform = `translateY(${headerHidden ? 0 : headerHeight}px)`;
    }

    function positionInboxPanel(panel) {
        const siteHeader = document.querySelector('#head, header, .Navigation');
        const headerHeight = Math.ceil(siteHeader?.getBoundingClientRect().height || 64);
        setInboxPanelHeaderVisibility(panel, headerHeight, panel.dataset.headerHidden === 'true');
    }

    function renderStarredTasks() {
        const panel = ensureStarredTasksPanel();
        const list = panel.querySelector('#pbs-starred-list');
        const tasks = getInboxTasks();

        positionInboxPanel(panel);
        if (!list) return;

        list.replaceChildren();
        if (tasks.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'Žádné sledované ani navštívené úkoly';
            empty.style.cssText = 'color: #888;';
            list.appendChild(empty);
            return;
        }

        const starredIds = new Set(readStarredTasks().map(task => String(task.id || '')));

        tasks.forEach(task => {
                const row = document.createElement('div');
                row.style.cssText = 'margin: 3px 0 6px 0; position: relative; cursor: pointer;';
                const isCompleted = Boolean(task.completed);
                if (task.hasNew && !isCompleted) {
                    row.style.fontWeight = '700';
                }
                const titleLine = document.createElement('div');
                titleLine.style.cssText = 'display: flex; align-items: flex-start; gap: 4px;';

                const starToggle = document.createElement('button');
                const isStarred = starredIds.has(String(task.id || ''));
                starToggle.type = 'button';
                starToggle.className = 'pbs-control';
                starToggle.textContent = isStarred ? '★' : '☆';
                starToggle.title = isStarred ? 'Přestat sledovat úkol' : 'Sledovat úkol';
                starToggle.setAttribute('aria-label', starToggle.title);
                starToggle.style.cssText = [
                    'border: 0',
                    'background: transparent',
                    'padding: 0',
                    'color: #f2c200',
                    'font-size: 15px',
                    'line-height: 1.2',
                    'cursor: pointer',
                    'flex: 0 0 15px',
                    'width: 15px'
                ].join(';');
                starToggle.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleTaskStar(task);
                });

                const link = document.createElement('a');
                const displayName = getTaskDisplayName(task);
                const taskUrl = getTaskUrl(task);
                link.href = taskUrl;
                link.textContent = displayName;
                link.style.cssText = 'color: #9f1607; text-decoration: none; min-width: 0; overflow-wrap: anywhere;';
                if (isCompleted) {
                    link.style.color = '#666';
                    link.style.textDecoration = 'line-through';
                }

                titleLine.appendChild(starToggle);
                titleLine.appendChild(link);
                row.appendChild(titleLine);

                const meta = document.createElement('div');
                const timeText = task.lastPostTime ? formatRelativeTime(task.lastPostTime) : 'Bez komentářů';
                const timeTotal = task.approvedTimeMinutes ? formatMinutesToHours(task.approvedTimeMinutes) : '';
                const authorText = task.lastPostAuthor ? ` · ${task.lastPostAuthor}` : '';
                const previewText = task.lastPostText?.trim() || '';
                const taskId = String(task.id || '');
                const checkingText = taskId && checkingTaskIds.has(taskId) ? ' · kontroluji…' : '';
                const checkError = taskCheckErrors.get(taskId);
                const errorText = checkError ? ' · kontrola selhala' : '';
                link.title = displayName;
                const leftText = document.createElement('span');
                leftText.textContent = `${timeText}${authorText}${checkingText}${errorText}`;
                if (checkError) {
                    leftText.title = checkError;
                    leftText.style.color = '#9f1607';
                }
                meta.style.cssText = [
                    'color: #666',
                    'font-size: 11px',
                    'display: flex',
                    'align-items: baseline',
                    'gap: 6px',
                    'box-sizing: border-box',
                    'padding-inline-start: 19px'
                ].join(';');
                if (task.client) {
                    const clientBadge = document.createElement('span');
                    const colors = getClientBadgeColors(task.client);
                    clientBadge.textContent = task.client;
                    clientBadge.style.cssText = [
                        'display: inline-flex',
                        'align-items: center',
                        'max-width: 110px',
                        'overflow: hidden',
                        'text-overflow: ellipsis',
                        'white-space: nowrap',
                        'padding: 1px 5px',
                        'border-radius: 999px',
                        `background: ${colors.background}`,
                        `color: ${colors.color}`,
                        'font-size: 10px',
                        'font-weight: 700',
                        'line-height: 1.3'
                    ].join(';');
                    clientBadge.title = task.client;
                    meta.appendChild(clientBadge);
                }
                meta.appendChild(leftText);
                if (task.lastPostTime) {
                    meta.title = formatTimestamp(task.lastPostTime);
                }

                const rightText = `${timeTotal}`.trim();
                if (rightText) {
                    const rightSpan = document.createElement('span');
                    rightSpan.textContent = rightText;
                    rightSpan.style.cssText = 'margin-left: auto; color: #888; font-weight: 700;';
                    meta.appendChild(rightSpan);
                }
                row.appendChild(meta);

                if (previewText) {
                    row.addEventListener('mouseenter', () => showTaskPreviewTooltip(row, previewText));
                    row.addEventListener('mouseleave', hideTaskPreviewTooltip);
                    link.addEventListener('focus', () => showTaskPreviewTooltip(row, previewText));
                    link.addEventListener('blur', hideTaskPreviewTooltip);
                }

                row.addEventListener('click', (event) => {
                    if (event.target.closest('a')) return;
                    window.location.href = taskUrl;
                });

            list.appendChild(row);
        });
    }

    function getTaskIdFromUrl(url) {
        try {
            const parsed = new URL(url);
            const id = parsed.searchParams.get('id');
            return id ? id.trim() : '';
        } catch (e) {
            return '';
        }
    }

    function normalizeStarredTasks() {
        const tasks = readStarredTasks();
        let changed = false;

        tasks.forEach(task => {
            if (!task.id && task.url) {
                const id = getTaskIdFromUrl(task.url);
                if (id) {
                    task.id = id;
                    changed = true;
                }
            }
        });

        if (changed) writeStarredTasks(tasks);
        return tasks;
    }

    function toggleTaskStar(task) {
        if (!task?.id) return;
        const tasks = readStarredTasks();
        const existingIndex = tasks.findIndex(item => String(item.id) === String(task.id));

        if (existingIndex >= 0) {
            tasks.splice(existingIndex, 1);
        } else {
            const displayName = getTaskDisplayName(task);
            tasks.push({
                ...task,
                name: displayName,
                originalName: task.originalName || task.name || displayName,
                url: getTaskUrl(task),
                hasNew: Boolean(task.hasNew)
            });
        }

        writeStarredTasks(tasks);
        updateCurrentTaskStarIcon();
        renderStarredTasks();
    }

    function updateCurrentTaskStarIcon() {
        const starToggle = document.getElementById('pbs-star-toggle');
        if (!starToggle) return;

        const currentTaskId = new URL(window.location.href).searchParams.get('id');
        const isStarred = readStarredTasks().some(task => String(task.id) === String(currentTaskId));
        starToggle.textContent = isStarred ? '★' : '☆';
        starToggle.title = isStarred ? 'Přestat sledovat úkol' : 'Sledovat úkol';
        starToggle.setAttribute('aria-label', starToggle.title);
    }

    function collectApprovedTimeWithoutCounterparts(doc) {
        const userNameSelector = '#head > div > nav > div.Navigation-userBar.UserBar.js-navigation-userbar > div > a > span > strong';
        const currentUserName = doc.querySelector(userNameSelector)?.textContent.trim()
            || document.querySelector(userNameSelector)?.textContent.trim()
            || '';

        if (!currentUserName) return [];

        const items = Array.from(doc.querySelectorAll('.timr'));
        const actualDescriptions = new Set(
            items
                .map(item => {
                    const descEls = item.querySelectorAll('.timrds');
                    if (descEls.length !== 1) return '';
                    return descEls[0]?.textContent.trim() || '';
                })
                .filter(Boolean)
        );
        const approvedRows = [];

        items.forEach(item => {
            const rowUserName = item.querySelector('.timru')?.textContent.trim() || '';
            if (rowUserName !== currentUserName) return;

            const dateText = item.querySelector('.timrd')?.textContent.trim() || '';
            const itemDate = dateText ? parseDate(dateText) : null;
            if (!itemDate) return;

            const descEls = item.querySelectorAll('.timrds');
            if (descEls.length < 2) return;

            const mainText = descEls[0]?.textContent.trim() || '';
            const lastText = descEls[descEls.length - 1]?.textContent.trim() || '';
            if (!mainText || !lastText.includes('Schváleno')) return;
            if (actualDescriptions.has(mainText)) return;

            const timeText = item.querySelector('.timrc')?.textContent.trim() || '';
            if (!timeText) return;

            approvedRows.push({
                element: item,
                description: mainText,
                timeText
            });
        });

        return approvedRows;
    }

    function getApprovedUniqueTimeFromDocument(doc) {
        let totalMinutes = 0;
        const approvedRows = collectApprovedTimeWithoutCounterparts(doc);

        approvedRows.forEach(row => {
            const minutes = parseTimeToMinutes(row.timeText);
            if (minutes > 0) totalMinutes += minutes;
        });

        return totalMinutes;
    }

    function getStatementRequestData(doc) {
        const taskElement = doc.querySelector('#pb-tasks');
        const taskId = taskElement?.dataset.taskId?.trim() || '';
        const workerId = taskElement?.dataset.workerId?.trim() || '';
        return /^\d+$/.test(taskId) && /^\d+$/.test(workerId) ? { taskId, workerId } : null;
    }

    async function getAjaxStatementTimeFromDocument(doc, signal) {
        const requestData = getStatementRequestData(doc);
        if (!requestData) return 0;

        const url = new URL('/ajax.php', window.location.origin);
        url.searchParams.set('action', 'statement');
        url.searchParams.set('type', 'mine');
        url.searchParams.set('task_id', requestData.taskId);
        url.searchParams.set('worker_id', requestData.workerId);

        const response = await fetch(url, {
            credentials: 'same-origin',
            signal
        });
        if (!response.ok) {
            throw new Error(`Výkaz času se nepodařilo načíst, server odpověděl stavem ${response.status}.`);
        }

        const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
        if (xml.querySelector('parsererror')) {
            throw new Error('Výkaz času má neplatný formát XML.');
        }

        const statementIds = new Set();
        let totalMinutes = 0;
        xml.querySelectorAll('statement').forEach(statement => {
            const statementId = statement.getAttribute('id') || '';
            if (!statementId || statementIds.has(statementId)) return;

            const capacity = Number.parseFloat(statement.getAttribute('capacity_raw') || '');
            if (!Number.isFinite(capacity) || capacity <= 0) return;

            statementIds.add(statementId);
            totalMinutes += Math.round(capacity * 60);
        });

        return totalMinutes;
    }

    async function getTotalApprovedTimeFromDocument(doc, signal) {
        const inlineMinutes = getApprovedUniqueTimeFromDocument(doc);
        const ajaxMinutes = await getAjaxStatementTimeFromDocument(doc, signal);
        return inlineMinutes + ajaxMinutes;
    }

    function getCommentTextWithLineBreaks(content) {
        const fragment = content.cloneNode(true);
        fragment.querySelectorAll('br').forEach(lineBreak => lineBreak.replaceWith('\n'));
        fragment.querySelectorAll('p, div, li, blockquote, pre, h1, h2, h3, h4, h5, h6').forEach(block => {
            block.append('\n');
        });
        return fragment.textContent
            .replace(/\r\n?/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function getLastPostInfoFromDocument(doc) {
        let latest = null;

        doc.querySelectorAll('.post.js-note-post').forEach(comment => {
            const content = comment.querySelector('.ck-content');
            if (!content) return;

            if (isSystemCommentContent(content)) return;

            const dateSpan = comment.querySelector('.Post-date');
            const date = dateSpan ? parseDate(dateSpan.textContent || '') : null;
            if (!date) return;

            if (!latest || date.getTime() > latest.time) {
                const author = comment.querySelector('.post-author')?.textContent.trim() || '';
                const text = getCommentTextWithLineBreaks(content);
                latest = {
                    time: date.getTime(),
                    author,
                    text
                };
            }
        });

        return latest;
    }

    function isTaskCompletedInDocument(doc) {
        return Boolean(extractTableData(doc, false)?.completed);
    }

    function formatTimestamp(timestamp) {
        const date = new Date(Number(timestamp));
        if (Number.isNaN(date.getTime())) return 'Neznámý čas';
        return new Intl.DateTimeFormat('cs-CZ', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    }

    function formatRelativeTime(timestamp) {
        const numericTimestamp = Number(timestamp);
        if (!Number.isFinite(numericTimestamp)) return 'Neznámý čas';
        const deltaMs = Math.max(0, Date.now() - numericTimestamp);
        if (deltaMs < 60 * 1000) return 'právě teď';
        const minutes = Math.floor(deltaMs / (60 * 1000));
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d`;
        return formatTimestamp(timestamp);
    }

    function parseTimeToMinutes(value) {
        const match = value.match(/^(\d+):(\d{2})$/);
        if (!match) return 0;
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        if (Number.isNaN(hours) || Number.isNaN(minutes) || minutes >= 60) return 0;
        return (hours * 60) + minutes;
    }

    function parseTimeParts(value) {
        const match = value.match(/^(\d+):(\d{2})$/);
        if (!match || Number(match[2]) >= 60) return null;
        return {
            hours: match[1],
            minutes: match[2]
        };
    }

    function formatMinutesToHours(totalMinutes) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return `${hours}:${String(minutes).padStart(2, '0')}`;
    }

    function trimText(text) {
        return (text || '').trim();
    }

    function updateStarredTaskById(id, updater) {
        const tasks = readStarredTasks();
        const index = tasks.findIndex(task => String(task.id) === String(id));
        if (index < 0) return { found: false, changed: false };

        const originalTask = tasks[index];
        const updatedTask = updater({ ...originalTask });
        const changed = updatedTask === null
            || JSON.stringify(originalTask) !== JSON.stringify(updatedTask);
        if (!changed) return { found: true, changed: false };

        if (updatedTask === null) {
            tasks.splice(index, 1);
        } else {
            tasks[index] = updatedTask;
        }
        writeStarredTasks(tasks);
        return { found: true, changed: true };
    }

    function updateVisitedTaskFromCheck(task, updates) {
        if (!task?.id) return { found: false, created: false, changed: false };
        const tasks = readVisitedTasks();
        const index = tasks.findIndex(item => String(item.id) === String(task.id));
        const currentTask = index >= 0 ? tasks[index] : task;
        const updatedTask = {
            ...currentTask,
            ...updates
        };
        if (updatedTask.completed) {
            updatedTask.completedAt = currentTask.completedAt || Date.now();
        } else {
            delete updatedTask.completedAt;
        }
        const changed = index < 0 || JSON.stringify(currentTask) !== JSON.stringify(updatedTask);
        if (!changed) return { found: true, created: false, changed: false };

        if (index >= 0) {
            tasks[index] = updatedTask;
        } else {
            tasks.push(updatedTask);
        }
        writeVisitedTasks(tasks);
        return { found: index >= 0, created: index < 0, changed: true };
    }

    function describeStorageUpdate(result) {
        if (result.created) return 'created';
        if (!result.found) return 'missing';
        return result.changed ? 'updated' : 'unchanged';
    }

    async function checkTasksForUpdates() {
        normalizeStarredTasks();
        const taskCandidates = getInboxTasks();
        const tasks = Array.from(
            new Map(taskCandidates.map(task => [String(task.id || task.url || ''), task])).values()
        ).filter(task => task.id);
        if (tasks.length === 0) return;

        const now = Date.now();

        for (const task of tasks) {
            if (!task.id) continue;

            const taskId = String(task.id);
            const taskUrl = getTaskUrl(task);
            if (!taskUrl) {
                taskCheckErrors.set(taskId, 'Úkol nemá platnou URL.');
                continue;
            }
            const lastVisitKey = `PBS_lastVisit_${task.id}`;
            const lastCheckKey = `PBS_lastCheck_v3_${task.id}`;
            const lastVisit = parseInt(safeGetStorageItem(lastVisitKey) || '0', 10);
            const lastCheck = parseInt(safeGetStorageItem(lastCheckKey) || '0', 10);
            if (lastCheck && now - lastCheck < TASK_CHECK_INTERVAL_MS) continue;

            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), TASK_CHECK_TIMEOUT_MS);
            try {
                checkingTaskIds.add(taskId);
                taskCheckErrors.delete(taskId);
                renderStarredTasks();
                const response = await fetch(taskUrl, {
                    credentials: 'same-origin',
                    signal: controller.signal
                });
                if (!response.ok) {
                    throw new Error(`Server odpověděl stavem ${response.status}.`);
                }
                const html = await response.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const fetchedTask = extractTableData(doc, false);
                if (!fetchedTask || String(fetchedTask.id) !== taskId) {
                    throw new Error('Server nevrátil očekávaný detail úkolu. Možná vypršelo přihlášení.');
                }

                const isCompleted = fetchedTask.completed;
                const latestInfo = getLastPostInfoFromDocument(doc);
                const latestTime = latestInfo ? latestInfo.time : 0;
                const lastLog = latestInfo
                    ? `${latestInfo.author} @ ${formatTimestamp(latestInfo.time)}`
                    : 'no posts';
                const approvedMinutes = await getTotalApprovedTimeFromDocument(doc, controller.signal);
                const starredUpdate = updateStarredTaskById(taskId, currentTask => {
                    if (latestInfo) {
                        currentTask.lastPostTime = latestInfo.time;
                        currentTask.lastPostAuthor = latestInfo.author;
                        currentTask.lastPostText = trimText(latestInfo.text, 500);
                    }
                    currentTask.approvedTimeMinutes = approvedMinutes;
                    currentTask.hasNew = Boolean(latestTime && lastVisit && latestTime > lastVisit);
                    currentTask.completed = isCompleted;
                    return currentTask;
                });
                const visitedUpdates = {
                    approvedTimeMinutes: approvedMinutes,
                    completed: isCompleted
                };
                if (latestInfo) {
                    visitedUpdates.lastPostTime = latestInfo.time;
                    visitedUpdates.lastPostAuthor = latestInfo.author;
                    visitedUpdates.lastPostText = trimText(latestInfo.text, 500);
                }
                const visitedUpdate = updateVisitedTaskFromCheck(task, visitedUpdates);
                console.info(`PBS check ${getTaskDisplayName(task)} (#${taskId})`, {
                    fetched: true,
                    statusText: fetchedTask.status || '(missing)',
                    completed: isCompleted,
                    lastPost: lastLog,
                    approvedTimeMinutes: approvedMinutes,
                    starredRecord: describeStorageUpdate(starredUpdate),
                    visitedRecord: describeStorageUpdate(visitedUpdate)
                });
                safeSetStorageItem(lastCheckKey, String(Date.now()));
            } catch (error) {
                const message = error.name === 'AbortError'
                    ? 'Kontrola vypršela. Zkuste to znovu při dalším načtení stránky.'
                    : error.message || 'Úkol se nepodařilo zkontrolovat.';
                taskCheckErrors.set(taskId, message);
                console.warn(`PBS check ${getTaskDisplayName(task)} failed: ${message}`);
            } finally {
                window.clearTimeout(timeoutId);
                checkingTaskIds.delete(taskId);
                renderStarredTasks();
            }
        }

        updateCurrentTaskStarIcon();
        renderStarredTasks();
    }

    async function updateCurrentTaskFromPage(taskMeta) {
        if (!taskMeta?.id || !taskMeta?.url) return;
        const taskId = taskMeta.id;
        const now = Date.now();
        const tasks = readStarredTasks();
        const match = tasks.find(task => String(task.id) === String(taskId));

        const latestInfo = getLastPostInfoFromDocument(document);
        if (latestInfo) {
            if (match) {
                match.lastPostTime = latestInfo.time;
                match.lastPostAuthor = latestInfo.author;
                match.lastPostText = trimText(latestInfo.text, 500);
            }
        }

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), TASK_CHECK_TIMEOUT_MS);
        let approvedMinutes;
        try {
            approvedMinutes = await getTotalApprovedTimeFromDocument(document, controller.signal);
        } catch (error) {
            console.warn('PBS: načtení výkazu času selhalo', error);
            approvedMinutes = getApprovedUniqueTimeFromDocument(document);
        } finally {
            window.clearTimeout(timeoutId);
        }
        if (match) {
            match.approvedTimeMinutes = approvedMinutes;
            match.completed = Boolean(taskMeta.completed);
            if (match.hasNew) match.hasNew = false;
            writeStarredTasks(tasks);
        }

        const visitedTasks = readVisitedTasks();
        const visitedIndex = visitedTasks.findIndex(task => String(task.id) === String(taskId) || task.url === taskMeta.url);
        const baseTask = visitedIndex >= 0 ? visitedTasks[visitedIndex] : {};
        const visitedTask = {
            ...baseTask,
            name: taskMeta.name,
            originalName: taskMeta.originalName || taskMeta.name,
            url: taskMeta.url,
            client: taskMeta.client,
            id: taskMeta.id,
            lastVisitedAt: now,
            approvedTimeMinutes: approvedMinutes,
            completed: Boolean(taskMeta.completed),
            hasNew: false
        };

        if (latestInfo) {
            visitedTask.lastPostTime = latestInfo.time;
            visitedTask.lastPostAuthor = latestInfo.author;
            visitedTask.lastPostText = trimText(latestInfo.text, 500);
        }

        if (visitedIndex >= 0) {
            visitedTasks[visitedIndex] = visitedTask;
        } else {
            visitedTasks.push(visitedTask);
        }
        writeVisitedTasks(visitedTasks);
        updateCurrentTaskStarIcon();
        renderStarredTasks();
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }

            const input = document.createElement('textarea');
            input.value = text;
            input.setAttribute('readonly', '');
            input.style.cssText = 'position: fixed; opacity: 0; pointer-events: none;';
            document.body.appendChild(input);
            input.select();
            const copied = document.execCommand('copy');
            input.remove();
            return copied;
        } catch (error) {
            console.warn('PBS: clipboard copy failed', error);
            return false;
        }
    }

    function fillStatementFormFromRow(timeText, description) {
        const form = document.querySelector('form[name="statementForm"]');
        if (!form) return;

        const parts = parseTimeParts(timeText);
        if (!parts) return;

        const hoursInput = form.querySelector('#ts_f_capacity_2');
        const minutesInput = form.querySelector('#ts_f_capacity_2_min');
        const descriptionField = form.querySelector('textarea[name="f_description"]');

        if (hoursInput) {
            hoursInput.value = parts.hours;
            hoursInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        if (minutesInput) {
            minutesInput.value = parts.minutes;
            minutesInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        if (descriptionField) {
            descriptionField.value = description;
            descriptionField.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const toggle = form.querySelector('.ars');
        if (toggle) {
            toggle.querySelector('.ply')?.click();
            toggle.querySelector('.min')?.click();
        }

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function addVykazatButtonsToApprovedRows() {
        const approvedRows = collectApprovedTimeWithoutCounterparts(document);
        if (approvedRows.length === 0) return;

        const form = document.querySelector('form[name="statementForm"]');

        approvedRows.forEach(row => {
            if (!row.element || row.element.querySelector('.pbs-vykazat-button')) return;

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'pbs-vykazat-button grbut but-small u-mt--20';
            button.textContent = 'Vykázat';
            button.style.cssText = 'margin-left: 8px; cursor: pointer; color: #fff; background-color: #c81b08;';
            button.addEventListener('click', (event) => {
                event.preventDefault();
                fillStatementFormFromRow(row.timeText, row.description);
            });

            const wrap = document.createElement('span');
            wrap.style.cssText = 'margin-left: 8px;';
            wrap.appendChild(button);
            row.element.appendChild(wrap);

            if (form) {
                form.insertAdjacentElement('afterend', row.element);
            }
        });
    }

    function setupHeader(originalName, id, client) {
        const h2 = document.querySelector('h2');
        let customName = getCustomTaskName(id);
        let displayName = customName || originalName;

        if (h2) {
            h2.className = 'u-text--red';
            h2.style.cssText = [
                'margin: 20px 10px',
                'display: flex',
                'align-items: flex-start',
                'gap: 8px',
                'min-width: 0',
                'position: relative',
                'left: -40px'
            ].join(';');
            h2.textContent = '';

            const starToggle = document.createElement('button');
            starToggle.type = 'button';
            starToggle.id = 'pbs-star-toggle';
            starToggle.className = 'pbs-control';
            starToggle.setAttribute('aria-label', 'Sledovat úkol');
            starToggle.style.cssText = [
                'cursor: pointer',
                'border: 0',
                'background: transparent',
                'padding: 0',
                'width: 32px',
                'height: 32px',
                'display: inline-flex',
                'align-items: center',
                'justify-content: center',
                'flex: 0 0 32px',
                'font-size: 28px',
                'line-height: 1',
                'color: #f2c200',
                'margin-top: 1px',
                'position: relative',
                'left: 10px'
            ].join(';');
            h2.appendChild(starToggle);

            const headingContent = document.createElement('div');
            headingContent.style.cssText = 'flex: 1 1 auto; min-width: 0;';
            h2.appendChild(headingContent);

            const nameLine = document.createElement('div');
            nameLine.style.cssText = 'display: flex; align-items: center; gap: 4px; min-width: 0; min-height: 34px; flex-wrap: wrap;';
            headingContent.appendChild(nameLine);

            const nameText = document.createElement('span');
            nameText.id = 'pbs-task-name';
            nameText.style.cssText = 'min-width: 0; overflow-wrap: anywhere; line-height: 1.15;';
            nameLine.appendChild(nameText);

            const renameButton = document.createElement('button');
            renameButton.type = 'button';
            renameButton.className = 'pbs-control';
            renameButton.textContent = '✎';
            renameButton.title = 'Přejmenovat úkol';
            renameButton.setAttribute('aria-label', renameButton.title);
            renameButton.style.cssText = 'border:0;background:transparent;color:#888;cursor:pointer;font-size:16px;padding:0 5px;';
            nameLine.appendChild(renameButton);

            const quickCopy = document.createElement('button');
            quickCopy.type = 'button';
            quickCopy.className = 'pbs-control';
            quickCopy.id = 'quickCopy';
            quickCopy.style.cssText = 'border:0;background:transparent;cursor:pointer;padding:2px 4px;';
            quickCopy.title = 'Kopírovat URL';
            quickCopy.setAttribute('aria-label', quickCopy.title);
            quickCopy.textContent = '🔗';
            nameLine.appendChild(quickCopy);

            const originalNameLine = document.createElement('div');
            originalNameLine.id = 'pbs-original-task-name';
            originalNameLine.style.cssText = 'font-size:11px;color:#888;font-weight:normal;margin-top:2px;display:flex;align-items:center;gap:4px;line-height:1.3;';
            headingContent.appendChild(originalNameLine);

            const resetButton = document.createElement('button');
            resetButton.type = 'button';
            resetButton.className = 'pbs-control';
            resetButton.textContent = '↺';
            resetButton.title = 'Obnovit původní název';
            resetButton.setAttribute('aria-label', resetButton.title);
            resetButton.style.cssText = 'border:0;background:transparent;color:#777;cursor:pointer;font-size:15px;line-height:1;padding:1px 2px;';

            const taskMeta = document.createElement('span');
            taskMeta.style.cssText = 'font-size:smaller;white-space:nowrap;flex:0 0 auto;line-height:34px;';
            taskMeta.textContent = `${client} #${id}`;
            h2.appendChild(taskMeta);

            const getParamUrl = () => buildParamUrl(createSlug(displayName), id, client);

            const updateHeader = () => {
                customName = getCustomTaskName(id);
                displayName = customName || originalName;
                nameText.textContent = displayName;
                originalNameLine.textContent = '';
                originalNameLine.style.display = customName ? 'flex' : 'none';
                if (customName) {
                    originalNameLine.append(originalName);
                    originalNameLine.appendChild(resetButton);
                }
                updateUrlParams(createSlug(displayName), client, id);
            };

            quickCopy.addEventListener('click', async () => {
                quickCopy.disabled = true;
                if (await copyText(getParamUrl())) {
                    quickCopy.textContent = '✔';
                    showPbsMessage('URL bylo zkopírováno.');
                } else {
                    quickCopy.textContent = '!';
                    showPbsMessage('URL se nepodařilo zkopírovat. Zkopírujte ho z adresního řádku.', true);
                }
                window.setTimeout(() => {
                    quickCopy.textContent = '🔗';
                    quickCopy.disabled = false;
                }, 1500);
            });

            const updateStarIcon = (isStarred) => {
                starToggle.textContent = isStarred ? '★' : '☆';
                starToggle.title = isStarred ? 'Přestat sledovat úkol' : 'Sledovat úkol';
                starToggle.setAttribute('aria-label', starToggle.title);
            };

            const isCurrentTaskStarred = () => readStarredTasks().some(task => String(task.id) === String(id));
            updateStarIcon(isCurrentTaskStarred());

            starToggle.addEventListener('click', () => {
                const visitedMatch = readVisitedTasks().find(task => String(task.id) === String(id));
                toggleTaskStar({
                    ...visitedMatch,
                    name: displayName,
                    originalName,
                    url: getParamUrl(),
                    client,
                    id
                });
                updateStarIcon(isCurrentTaskStarred());
            });

            renameButton.addEventListener('click', () => {
                const nextName = window.prompt('Nový název úkolu:', displayName);
                if (nextName === null) return;
                const trimmedName = nextName.trim();
                if (!trimmedName) {
                    showPbsMessage('Název úkolu nesmí být prázdný.', true);
                    return;
                }
                if (trimmedName.length > 200) {
                    showPbsMessage('Název úkolu může mít nejvýše 200 znaků.', true);
                    return;
                }
                if (!createSlug(trimmedName)) {
                    showPbsMessage('Název musí obsahovat alespoň jedno písmeno nebo číslo.', true);
                    return;
                }

                writeCustomTaskName(id, trimmedName === originalName ? '' : trimmedName);
                updateStoredTaskName(id, originalName, client);
                updateHeader();
                renderStarredTasks();
            });

            resetButton.addEventListener('click', () => {
                writeCustomTaskName(id, '');
                updateStoredTaskName(id, originalName, client);
                updateHeader();
                renderStarredTasks();
            });

            updateHeader();
            renderStarredTasks();
        }
        return h2;
    }
    function cleanupElements() {
        document.querySelectorAll('[id*="disch"]').forEach(el => {
            el.style.display = 'none';
        });
        document.querySelectorAll('.post-status').forEach(el => {
            el.style.display = 'none';
        });

        const wdesc = document.getElementById('wdesc2');
        if (wdesc) {
            const table = wdesc.closest('table.itable');
            if (table) table.style.display = 'none';
        }
        const newpost = document.getElementById('newpost');
        const disw = document.getElementById('disw');

        if (newpost) newpost.style.marginTop = 0;
        if (disw) disw.style.marginTop = 0;
    }

    function setupEditFormToggle() {
        const form = document.getElementById('editTaskForm');
        if (!form || document.getElementById('pbs-edit-form-toggle')) return;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'pbs-edit-form-toggle';
        toggle.className = 'grbut but-small u-mt--20';
        toggle.setAttribute('aria-controls', form.id);
        toggle.setAttribute('aria-expanded', 'false');

        const updateToggle = (isOpen) => {
            form.hidden = !isOpen;
            toggle.textContent = isOpen ? 'Skrýt editaci' : 'Zobrazit editaci';
            toggle.setAttribute('aria-expanded', String(isOpen));
        };

        toggle.addEventListener('click', () => {
            updateToggle(form.hidden);
        });

        form.insertAdjacentElement('beforebegin', toggle);
        updateToggle(false);
    }

    function getSafeUrl(value) {
        if (!value) return '';
        try {
            const url = new URL(value, window.location.origin);
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch (error) {
            return '';
        }
    }

    function sanitizeHtmlFragment(html) {
        const template = document.createElement('template');
        template.innerHTML = html || '';
        template.content.querySelectorAll('script, iframe, object, embed, form, input, button, meta, link, base, svg, math').forEach(
            element => element.remove()
        );
        template.content.querySelectorAll('*').forEach(element => {
            Array.from(element.attributes).forEach(attribute => {
                const name = attribute.name.toLowerCase();
                if (name.startsWith('on') || ['srcdoc', 'srcset', 'formaction', 'style', 'ping'].includes(name)) {
                    element.removeAttribute(attribute.name);
                    return;
                }
                if (['href', 'src'].includes(name) || name.endsWith(':href')) {
                    const safeUrl = getSafeUrl(attribute.value);
                    if (safeUrl) {
                        element.setAttribute(attribute.name, safeUrl);
                    } else {
                        element.removeAttribute(attribute.name);
                    }
                }
            });
            if (element.tagName === 'A' && element.getAttribute('target') === '_blank') {
                element.setAttribute('rel', 'noopener noreferrer');
            }
        });
        return template.content;
    }

    function handleDescriptionContent() {
        const devDesc = document.getElementById('developer-description-text');
        const iframe = devDesc?.querySelector('iframe');
        let descContent = '';

        if (iframe) {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                descContent = iframeDoc?.body.innerHTML || '';
            } catch (e) {
                descContent = '';
            }
        }

        descContent = descContent.replace('<base target="_blank">', '');

        const descTabs = document.getElementById('desc-tabs');
        if (descTabs) descTabs.style.display = 'none';

        if (!descContent) return;

        const newComment = document.createElement('div');
        newComment.id = 'note-0';
        newComment.className = 'post js-note-post public';
        newComment.setAttribute('data-index', '0');
        newComment.setAttribute('data-id', '0');
        newComment.setAttribute('data-status', '');

        const grid = document.createElement('div');
        grid.className = 'Grid';
        const post = document.createElement('div');
        post.className = 'Grid-cell Post u-xs-size12of12 u-size10of12 u-lg-size12of12';
        post.style.borderColor = '#f50541';
        const postHeader = document.createElement('div');
        postHeader.className = 'post-header Post-headerContent';
        postHeader.style.backgroundColor = '#f50541';
        const headerInner = document.createElement('div');
        const anchor = document.createElement('a');
        anchor.href = '#note-0';
        anchor.className = 'anchor post-anchor';
        anchor.textContent = '#0';
        const address = document.createElement('div');
        address.className = 'Post-address';
        const author = document.createElement('span');
        author.className = 'post-author';
        author.textContent = 'Zadání';
        const postContent = document.createElement('div');
        postContent.className = 'Post-content';
        const content = document.createElement('div');
        content.className = 'ck-content';
        content.id = 'commentText-0';
        content.appendChild(sanitizeHtmlFragment(descContent));

        address.appendChild(author);
        headerInner.append(anchor, address);
        postHeader.appendChild(headerInner);
        postContent.appendChild(content);
        post.append(postHeader, postContent);
        grid.appendChild(post);
        newComment.appendChild(grid);

        const discussDiv = document.getElementById('discuss');
        if (discussDiv) discussDiv.appendChild(newComment);
    }

    function reorganizeDOM() {
        const discussDiv = document.getElementById('discuss');
        const gridDiv = document.querySelector('div.fl.Grid');
        const wrkrsDiv = document.getElementById('wrkrs');

        if (discussDiv && gridDiv) discussDiv.after(gridDiv);
        if (gridDiv && wrkrsDiv) gridDiv.after(wrkrsDiv);
    }

    function parseDate(dateStr) {
        const match = dateStr.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{2}):(\d{2})/);
        if (!match) return null;
        const [, day, month, year, hour, minute] = match;
        const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
        if (
            date.getFullYear() !== Number(year)
            || date.getMonth() !== Number(month) - 1
            || date.getDate() !== Number(day)
            || date.getHours() !== Number(hour)
            || date.getMinutes() !== Number(minute)
        ) {
            return null;
        }
        return date;
    }

    function handleVisitTracking(id) {
        const now = new Date();
        const lastVisitKey = `PBS_lastVisit_${id}`;
        const lastVisit = safeGetStorageItem(lastVisitKey);
        safeSetStorageItem(lastVisitKey, now.getTime().toString());

        if (!lastVisit) return 0;

        const comments = document.querySelectorAll('.post.js-note-post');
        const lastVisitTime = parseInt(lastVisit, 10);
        const discussDiv = document.getElementById('discuss');

        for (const comment of comments) {
            const dateSpan = comment.querySelector('.Post-date');
            const commentDate = dateSpan ? parseDate(dateSpan.textContent) : null;

            if (commentDate && commentDate.getTime() > lastVisitTime) {
                const redLine = document.createElement('div');
                redLine.id = 'newpost-anchor';
                redLine.style.cssText = 'border-top: 3px solid red; margin: 10px 0;';
                comment.after(redLine);

                const link = document.createElement('a');

                link.href = '#';
                link.textContent = 'K novému komentáři';
                link.style.cssText = 'float: left;margin-left: 10px;color: #c81b08;font-weight: 700;';

                link.addEventListener('click', function(){
                    const anchor = document.getElementById('newpost-anchor');
                    if (!anchor) return;

                    const previous = anchor.previousElementSibling;
                    if (!previous) return;

                    const offset = 20;
                    const elementPosition = previous.getBoundingClientRect().top + window.scrollY - offset;

                    window.scrollTo({ top: elementPosition, behavior: 'smooth' });
                });

                if (discussDiv) discussDiv.insertAdjacentElement('afterbegin', link);
                break;
            }
        }

        return lastVisitTime;
    }

    function updateUrlParams(slug, client, id) {
        const builtUrl = new URL(buildParamUrl(slug, id, client));

        window.history.replaceState(null, '', builtUrl);
    }

    function hideNotes() {
        setTimeout(() => {
            const notes = document.getElementById('pb-tasks-inner-container');
            const notepad = document.getElementById('PBS_TASKS');

            if (!notes || !notepad) {
                return;
            }

            if (notes.children.length !== 0) {
                return;
            }

            notepad.style.display = 'none';

            const existingToggleLink = document.getElementById('disw');
            if (existingToggleLink) {
                return;
            }

            const toggleLink = document.createElement('a');
            toggleLink.href = '#';
            toggleLink.id = 'disw';
            toggleLink.style = 'float:left;color: #c81b08;margin-top:0;';
            toggleLink.textContent = 'Úkolníček je prázdný - Zobrazit';
            toggleLink.addEventListener('click', (e) => {
                e.preventDefault();
                notepad.style.display = 'block';
                toggleLink.remove();
            });

            notepad.parentNode?.insertBefore(toggleLink, notepad);
        }, 250);
    }

    function createFilePreview(href, filename, status = '') {
        const safeHref = getSafeUrl(href);
        if (!safeHref) return null;

        const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
        const extension = (filename.split('.').pop() || '').toLowerCase();
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; gap: 1rem; align-items: center; min-width: 0;';

        if (imageExtensions.has(extension)) {
            const imageLink = document.createElement('a');
            imageLink.href = safeHref;
            imageLink.target = '_blank';
            imageLink.rel = 'noopener noreferrer';
            imageLink.className = 'progressName';
            const image = document.createElement('img');
            image.src = safeHref;
            image.alt = filename;
            image.loading = 'lazy';
            image.style.cssText = 'max-width: 250px; width: 100%; height: 150px; object-fit: contain; border: 1px solid #ccc; border-radius: 4px;';
            imageLink.appendChild(image);
            wrapper.appendChild(imageLink);
        } else {
            const icon = document.createElement('span');
            icon.textContent = '📄';
            icon.setAttribute('aria-hidden', 'true');
            icon.style.cssText = 'font-size: 2rem; flex: 0 0 auto;';
            wrapper.appendChild(icon);
        }

        const details = document.createElement('div');
        details.style.cssText = 'min-width: 0; overflow-wrap: anywhere;';
        const downloadLink = document.createElement('a');
        downloadLink.href = safeHref;
        downloadLink.download = filename;
        downloadLink.className = 'progressName';
        downloadLink.textContent = filename;
        downloadLink.style.color = '#9f1607';
        details.appendChild(downloadLink);

        if (status) {
            const statusLine = document.createElement('div');
            statusLine.textContent = status;
            statusLine.style.cssText = 'font-size: 0.875rem; color: #666; margin-block: 0.5rem;';
            details.appendChild(statusLine);
        }

        wrapper.appendChild(details);
        return wrapper;
    }

    function improveFiles(){

        const heading = Array.from(document.querySelectorAll('label')).find(
            label =>
                label.classList.contains('Grid-cell') &&
                label.classList.contains('u-w--90') &&
                label.textContent.includes('Přílohy')
        );

        if (!heading) return;

        const section = heading.closest('.fl');
        if (!section) return;

        const cellContainer = section.querySelector('.Grid-cell.u-size10of12');
        if (cellContainer) {
            cellContainer.classList.remove('u-size10of12');
            cellContainer.classList.add('u-size12of12');
        }

        section.querySelectorAll('.progressContainer').forEach(container => {
            const link = container.querySelector('.progressName a');
            if (!link) return;

            const href = link.getAttribute('href');
            const filename = normalizeText(link.textContent) || 'Soubor';
            const status = normalizeText(container.querySelector('.progressBarStatus')?.textContent);
            const preview = createFilePreview(href, filename, status);
            if (!preview) return;

            container.className = '';
            container.style.border = '1px solid lightgrey';
            container.style.padding = '10px';
            container.style.marginBottom = '5px';
            container.replaceChildren(preview);
        });
    }

    function attachFilesToComments(){
        const filesData = [];

        document.querySelectorAll('.progressContainer').forEach(container => {
            const link = container.querySelector('.progressName a');
            if (!link) return;

            const href = link.getAttribute('href');
            const filename = normalizeText(link.textContent) || 'Soubor';
            const statusText = container.querySelector('.progressBarStatus')?.textContent || '';

            const timeMatch = statusText.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})/);
            if (timeMatch) {
                filesData.push({
                    href,
                    filename,
                    date: timeMatch[1],
                    time: `${timeMatch[2]}:${timeMatch[3]}`,
                    used: false
                });
            }
        });

        document.querySelectorAll('.post.js-note-post').forEach(comment => {
            const contentDiv = comment.querySelector('.ck-content');
            if (!contentDiv || contentDiv.textContent.trim() !== 'Přidána příloha k úkolu') return;

            const dateSpan = comment.querySelector('.Post-date');
            if (!dateSpan) return;

            const dateMatch = dateSpan.textContent.match(/(\d{1,2})\.\s+(\d{1,2})\.\s+(\d{4})\s+(\d{2}):(\d{2})/);
            if (!dateMatch) return;

            const [, day, month, year, hour, minute] = dateMatch;
            const commentDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const commentTime = `${hour}:${minute}`;

            const fileData = filesData.find(f =>
                f.date === commentDate && f.time === commentTime && !f.used
            );
            if (!fileData) return;

            fileData.used = true;

            const fileDiv = document.createElement('div');
            fileDiv.style.padding = '10px';
            fileDiv.style.marginTop = '10px';
            const preview = createFilePreview(fileData.href, fileData.filename);
            if (!preview) return;
            fileDiv.appendChild(preview);

            contentDiv.parentNode?.insertBefore(fileDiv, contentDiv.nextSibling);
        });
    }
    function addBodyStyles(){
        const body = document.getElementById('body');
        if (body) {
            body.style.marginTop = '60px';
            body.style.borderRadius = '10px';
            body.style.paddingTop = '5px';
        }
    }

    function initHeaderScroll(){
        const head = document.getElementById('head');
        if (!head) return;

        let lastScrollTop = 0;
        head.style.position = "fixed";
        head.style.top = "0";
        head.style.transition = "transform 0.3s ease-in-out";
        head.style.zIndex = "1000";
        head.style.background = "linear-gradient(180deg,rgba(214, 214, 214, 1) 0%, rgba(214, 214, 214, 1) 75%, rgba(237, 83, 83, 0) 100%)"

        const style = document.createElement('style');
        style.textContent = `
        .Navigation-link,
        .main-nav__btn-content,
        .my-time {
            color: black !important;
        }
        .post-header {min-height:0}
        .Navigation-link:hover,
        .main-nav__btn-content:hover,
        .my-time:hover {
            color: white !important;
        }
        .Navigation-link.active{
            border: none !important;
        }
    `;
        document.head.appendChild(style);
        document.querySelectorAll(".Navigation-logo").forEach(element => {
            element.style.filter = 'drop-shadow(0px 0px 4px grey)';
            element.style.marginTop = '-3px';
        });
        document.getElementById("environment")?.remove();
        document.querySelectorAll("#head > div > nav > div.Navigation-userBar.UserBar.js-navigation-userbar > div > a > span > small:nth-child(2)").forEach(element => {
            element.style.float= "left";
            element.style.color= "black";
            element.style.marginRight = "3px";
        });

        let scrollFrame = null;
        window.addEventListener('scroll', () => {
            if (scrollFrame !== null) return;
            scrollFrame = window.requestAnimationFrame(() => {
                const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
                const headerHidden = currentScroll > lastScrollTop;
                head.style.transform = headerHidden ? 'translateY(-100%)' : 'translateY(0)';
                const inboxPanel = document.getElementById('pbs-starred-panel');
                if (inboxPanel) {
                    setInboxPanelHeaderVisibility(inboxPanel, head.offsetHeight, headerHidden);
                }
                lastScrollTop = Math.max(0, currentScroll);
                scrollFrame = null;
            });
        }, { passive: true });
    }

    function hideSystemComments(){
        document.querySelectorAll('.post.js-note-post').forEach(comment => {
            const content = comment.querySelector('.ck-content');
            if (!content) return;

            if (isSystemCommentContent(content)) {
                //   comment.style.display = 'none';
                comment.style.transform = "scale(0.5)";
                comment.style.opacity = '0.3';
                comment.style.transition = 'all 0.2s';

                comment.addEventListener('mouseenter', () => {
                    comment.style.opacity = '1';
                    comment.style.transform = "scale(1)";
                });

                comment.addEventListener('mouseleave', () => {
                    comment.style.opacity = '0.3';
                    comment.style.transform = "scale(0.5)";
                });
            }
        });
    }

    function init() {
        if (checkPostRequest()) return;
        if (handlePathRedirect()) return;
        if (!isTaskDetailUrl()) return;

        const data = extractTableData();
        if (!data) return;

        const customName = getCustomTaskName(data.id);
        const displayName = customName || data.name;
        const nameSlug = createSlug(displayName);
        setupHeader(data.name, data.id, data.client);

        cleanupElements();
        setupEditFormToggle();
        handleDescriptionContent();
        reorganizeDOM();
        updateUrlParams(nameSlug, data.client, data.id);
        const currentTaskMeta = {
            id: data.id,
            name: displayName,
            originalName: data.name,
            client: data.client,
            url: buildParamUrl(nameSlug, data.id, data.client),
            completed: isTaskCompletedInDocument(document)
        };
        handleVisitTracking(data.id);
        updateCurrentTaskFromPage(currentTaskMeta);
        addVykazatButtonsToApprovedRows();
        hideNotes();
        attachFilesToComments();
        improveFiles();
        checkTasksForUpdates();

        addBodyStyles();
        initHeaderScroll();
        hideSystemComments();
        trackPostSubmissions();
    }

    init();
})();
