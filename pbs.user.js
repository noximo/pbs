// ==UserScript==
// @name         PBS
// @namespace    https://github.com/noximo/pbs
// @version      0.1.0
// @description  Add project name as query param and redirect
// @match        https://pbs2.praguebest.cz/main.php*action=detail*
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
        /^<strong>Přidáno:/,
        /^Změna času spolupracovníka/,
        /^Uživatel požádal o čas/,
        /^Změna autora/,
        /^<strong>Předáno:.*?<\/strong><br>\s*$/
    ];
    const checkingTaskIds = new Set();

    function isSystemCommentContent(html) {
        const text = (html || '').trim();
        return systemCommentPatterns.some(pattern => pattern.test(text));
    }

    function checkPostRequest() {
        return performance.getEntriesByType('navigation')[0]?.nextHopProtocol === 'POST';
    }

    function handlePathRedirect() {
        const pathParts = window.location.pathname.split('/').filter(p => p);
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
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w\-]/g, '')
            .replace(/\-+/g, '-')
            .replace(/^\-|\-$/g, '');
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
        return `https://pbs2.praguebest.cz/main.php?action=detail&id=${id}&t=${encodeURIComponent(tValue)}`;
    }

    function extractTableData() {
        const table = document.querySelector('table.itable');
        if (!table) return null;

        let data = { name: '', id: '', client: '' };
        const rows = table.querySelectorAll('tbody tr');

        for (const row of rows) {
            const th = row.querySelector('th');
            if (!th) continue;
            const td = row.querySelector('td');
            if (!td) continue;

            if (th.textContent.includes('Název:')) data.name = td.textContent.trim();
            if (th.textContent.trim() === 'ID:') data.id = td.textContent.trim();
            if (th.textContent.includes('Zákazník:')) data.client = td.textContent.trim();
        }

        table.style.display = 'none';
        return data;
    }

    function readStarredTasks() {
        const stored = localStorage.getItem('PBS_starred_tasks');
        if (!stored) return [];
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    const TASK_LIST_MODE_KEY = 'PBS_task_list_mode';
    const TASK_LIST_MODE_STARRED = 'starred';
    const TASK_LIST_MODE_VISITED = 'visited';
    const VISITED_TASKS_KEY = 'PBS_visited_tasks';
    const TASK_LIST_COLLAPSED_KEY = 'PBS_task_list_collapsed';

    function writeStarredTasks(tasks) {
        localStorage.setItem('PBS_starred_tasks', JSON.stringify(tasks));
    }

    function readTaskListMode() {
        const stored = localStorage.getItem(TASK_LIST_MODE_KEY);
        return stored === TASK_LIST_MODE_VISITED ? TASK_LIST_MODE_VISITED : TASK_LIST_MODE_STARRED;
    }

    function writeTaskListMode(mode) {
        const value = mode === TASK_LIST_MODE_VISITED ? TASK_LIST_MODE_VISITED : TASK_LIST_MODE_STARRED;
        localStorage.setItem(TASK_LIST_MODE_KEY, value);
    }

    function readVisitedTasks() {
        const stored = localStorage.getItem(VISITED_TASKS_KEY);
        if (!stored) return [];
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function writeVisitedTasks(tasks) {
        localStorage.setItem(VISITED_TASKS_KEY, JSON.stringify(tasks));
    }

    function isTaskListCollapsed() {
        return localStorage.getItem(TASK_LIST_COLLAPSED_KEY) === '1';
    }

    function writeTaskListCollapsed(collapsed) {
        localStorage.setItem(TASK_LIST_COLLAPSED_KEY, collapsed ? '1' : '0');
    }

    function ensureStarredTasksPanel() {
        let panel = document.getElementById('pbs-starred-panel');
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = 'pbs-starred-panel';
        panel.style.cssText = [
            'position: fixed',
            'right: 16px',
            'bottom: 16px',
            'z-index: 9999',
            'background: rgba(255,255,255,0.95)',
            'border: 1px solid #ddd',
            'border-radius: 8px',
            'box-shadow: 0 6px 20px rgba(0,0,0,0.12)',
            'padding: 10px 12px',
            'text-align: left',
            'line-height: 1.5em',
            'font-size: 12px',
            'max-width: 260px',
            'max-height: 50vh',
            'overflow: auto'
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = [
            'display: flex',
            'align-items: center',
            'justify-content: space-between',
            'gap: 8px',
            'margin-bottom: 6px',
            'cursor: pointer'
        ].join(';');

        const title = document.createElement('div');
        title.id = 'pbs-task-list-title';
        title.style.cssText = 'font-weight: 700; color: #333;';
        header.appendChild(title);

        const viewToggle = document.createElement('a');
        viewToggle.href = '#';
        viewToggle.id = 'pbs-task-list-toggle';
        viewToggle.style.cssText = [
            'font-size: 11px',
            'color: #c81b08',
            'text-decoration: none',
            'font-weight: 700'
        ].join(';');

        function updateViewToggleLabel() {
            const mode = readTaskListMode();
            viewToggle.textContent = mode === TASK_LIST_MODE_VISITED
                ? 'Zobrazení: navštívené'
                : 'Zobrazení: sledované';
        }

        function updateHeaderLabel() {
            title.textContent = `${isTaskListCollapsed() ? '▸' : '▾'} Sledované úkoly`;
        }

        viewToggle.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const nextMode = readTaskListMode() === TASK_LIST_MODE_VISITED
                ? TASK_LIST_MODE_STARRED
                : TASK_LIST_MODE_VISITED;
            writeTaskListMode(nextMode);
            updateViewToggleLabel();
            renderStarredTasks();
        });

        header.addEventListener('click', () => {
            writeTaskListCollapsed(!isTaskListCollapsed());
            renderStarredTasks();
        });

        updateViewToggleLabel();
        updateHeaderLabel();
        header.appendChild(viewToggle);
        panel.appendChild(header);

        const list = document.createElement('div');
        list.id = 'pbs-starred-list';
        list.style.display = isTaskListCollapsed() ? 'none' : 'block';
        panel.appendChild(list);

        document.body.appendChild(panel);
        return panel;
    }

    function getLastVisitTimeForTask(task) {
        if (!task?.id) return 0;
        const value = localStorage.getItem(`PBS_lastVisit_${task.id}`);
        return value ? parseInt(value, 10) || 0 : 0;
    }

    function getTasksForActiveMode() {
        const mode = readTaskListMode();
        const starredTasks = readStarredTasks();

        if (mode === TASK_LIST_MODE_STARRED) {
            return starredTasks;
        }

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
            .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);

        const nonStarredVisited = recentVisited
            .filter(task => !starredIds.has(String(task.id || '')))
            .slice(0, 15);

        return [...starredTasks, ...nonStarredVisited];
    }

    function renderStarredTasks() {
        const panel = ensureStarredTasksPanel();
        const list = panel.querySelector('#pbs-starred-list');
        const title = panel.querySelector('#pbs-task-list-title');
        const tasks = getTasksForActiveMode();
        const collapsed = isTaskListCollapsed();

        if (title) {
            title.textContent = `${collapsed ? '▸' : '▾'} Sledované úkoly`;
        }

        if (list) {
            list.style.display = collapsed ? 'none' : 'block';
        }

        list.innerHTML = '';
        if (tasks.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = readTaskListMode() === TASK_LIST_MODE_VISITED
                ? 'Žádné navštívené úkoly'
                : 'Žádné sledované úkoly';
            empty.style.cssText = 'color: #888;';
            list.appendChild(empty);
            return;
        }

        const sortedTasks = [...tasks].sort((a, b) => {
            const aVisit = Number(a.lastVisitedAt || getLastVisitTimeForTask(a) || 0);
            const bVisit = Number(b.lastVisitedAt || getLastVisitTimeForTask(b) || 0);
            if (bVisit !== aVisit) return bVisit - aVisit;
            return (b.lastPostTime || 0) - (a.lastPostTime || 0);
        });

        const byClient = new Map();

        sortedTasks.forEach(task => {
            const clientName = task.client || 'Neznámý klient';
            if (!byClient.has(clientName)) byClient.set(clientName, []);
            byClient.get(clientName).push(task);
        });

        Array.from(byClient.entries()).forEach(([clientName, clientTasks]) => {
            const clientHeader = document.createElement('div');
            clientHeader.textContent = clientName;
            clientHeader.style.cssText = 'margin-top: 6px; font-weight: 700; color: #333;';
            list.appendChild(clientHeader);

            clientTasks.forEach(task => {
                const row = document.createElement('div');
                row.style.cssText = 'margin: 3px 0 6px 0; position: relative; cursor: pointer;';
                if (task.hasNew) {
                    row.style.fontWeight = '700';
                }

                const link = document.createElement('a');
                link.href = task.url;
                link.textContent = task.name;
                link.style.cssText = 'color: #c81b08; text-decoration: none;';

                row.appendChild(link);

                const meta = document.createElement('div');
                const timeText = task.lastPostTime ? formatRelativeTime(task.lastPostTime) : 'Bez komentářů';
                const timeTotal = task.approvedTimeMinutes ? formatMinutesToHours(task.approvedTimeMinutes) : '';
                const authorText = task.lastPostAuthor ? ` · ${task.lastPostAuthor}` : '';
                const cleanText = task.lastPostText ? task.lastPostText.replace(/\s+/g, ' ').trim() : '';
                const previewLimit = 240;
                const previewText = cleanText ? cleanText.slice(0, previewLimit) : '';
                const checkingText = task.id && checkingTaskIds.has(task.id) ? ' · kontroluji...' : '';
                link.title = task.name;
                const leftText = document.createElement('span');
                leftText.textContent = `${timeText}${authorText}${checkingText}`;
                meta.appendChild(leftText);
                meta.style.cssText = [
                    'color: #666',
                    'font-size: 11px',
                    'display: flex',
                    'align-items: baseline',
                    'gap: 6px'
                ].join(';');
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
                    const textLine = document.createElement('div');
                    textLine.textContent = previewText;
                    textLine.style.cssText = [
                        'font-size: 11px',
                        'color: #888',
                        'overflow: hidden',
                        'white-space: normal',
                        'line-height: 1.2',
                        task.hasNew ? 'max-height: 1.2em' : 'max-height: 0',
                        task.hasNew ? 'opacity: 1' : 'opacity: 0',
                        task.hasNew ? 'margin-top: 0' : 'margin-top: 0',
                        'transition: max-height 0.15s ease, opacity 0.15s ease'
                    ].join(';');
                    row.appendChild(textLine);

                    row.addEventListener('mouseenter', () => {
                        textLine.style.maxHeight = '7.2em';
                        textLine.style.opacity = '1';
                    });

                    row.addEventListener('mouseleave', () => {
                        textLine.style.maxHeight = task.hasNew ? '1.2em' : '0';
                        textLine.style.opacity = task.hasNew ? '1' : '0';
                    });
                }

                row.addEventListener('click', (event) => {
                    if (event.target.closest('a')) return;
                    window.location.href = task.url;
                });

                list.appendChild(row);
            });
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

    function collectApprovedTimeWithoutCounterparts(doc) {
        const cutoffMs = 1769598969 * 1000;
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
            if (!itemDate || itemDate.getTime() < cutoffMs) return;

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

    function getLastPostInfoFromDocument(doc) {
        let latest = null;

        doc.querySelectorAll('.post.js-note-post').forEach(comment => {
            const content = comment.querySelector('.ck-content');
            if (!content) return;

            const html = content.innerHTML.trim();
            if (isSystemCommentContent(html)) return;

            const dateSpan = comment.querySelector('.Post-date');
            const date = dateSpan ? parseDate(dateSpan.textContent || '') : null;
            if (!date) return;

            if (!latest || date.getTime() > latest.time) {
                const author = comment.querySelector('.post-author')?.textContent.trim() || '';
                const text = content.textContent.trim();
                latest = {
                    time: date.getTime(),
                    author,
                    text
                };
            }
        });

        return latest;
    }

    function formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        return `${day}.${month}.${year} ${hour}:${minute}`;
    }

    function formatRelativeTime(timestamp) {
        const deltaMs = Date.now() - timestamp;
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
        if (Number.isNaN(hours) || Number.isNaN(minutes)) return 0;
        return (hours * 60) + minutes;
    }

    function parseTimeParts(value) {
        const match = value.match(/^(\d+):(\d{2})$/);
        if (!match) return null;
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

    function trimText(text, maxLength) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
    }

    async function checkStarredTasksForUpdates() {
        const tasks = normalizeStarredTasks();
        if (tasks.length === 0) return;

        const now = Date.now();
        let changed = false;

        for (const task of tasks) {
            if (!task.id || !task.url) continue;

            const lastVisitKey = `PBS_lastVisit_${task.id}`;
            const lastCheckKey = `PBS_lastCheck_${task.id}`;
            const lastVisit = parseInt(localStorage.getItem(lastVisitKey) || '0', 10);

            try {
                checkingTaskIds.add(task.id);
                renderStarredTasks();
                const response = await fetch(task.url);
                if (!response.ok) continue;
                const html = await response.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const latestInfo = getLastPostInfoFromDocument(doc);
                const latestTime = latestInfo ? latestInfo.time : 0;
                const lastLog = latestInfo
                    ? `${latestInfo.author} @ ${formatTimestamp(latestInfo.time)}`
                    : 'no posts';
                console.log(`PBS check ${task.name}: ${lastLog}`);

                if (latestInfo) {
                    if (latestInfo.time && task.lastPostTime !== latestInfo.time) {
                        task.lastPostTime = latestInfo.time;
                        changed = true;
                    }
                    if (task.lastPostAuthor !== latestInfo.author) {
                        task.lastPostAuthor = latestInfo.author;
                        changed = true;
                    }
                    const trimmedText = trimText(latestInfo.text, 500);
                    if (task.lastPostText !== trimmedText) {
                        task.lastPostText = trimmedText;
                        changed = true;
                    }
                }

                const approvedMinutes = getApprovedUniqueTimeFromDocument(doc);
                if (task.approvedTimeMinutes !== approvedMinutes) {
                    task.approvedTimeMinutes = approvedMinutes;
                    changed = true;
                }

                if (latestTime && lastVisit && latestTime > lastVisit) {
                    if (!task.hasNew) {
                        task.hasNew = true;
                        changed = true;
                    }
                } else if (task.hasNew) {
                    task.hasNew = false;
                    changed = true;
                }
                localStorage.setItem(lastCheckKey, String(now));
            } catch (e) {
                // Ignore failed background fetches.
            } finally {
                if (checkingTaskIds.has(task.id)) {
                    checkingTaskIds.delete(task.id);
                    renderStarredTasks();
                }
            }
        }

        if (changed) writeStarredTasks(tasks);
        renderStarredTasks();
    }

    function updateCurrentTaskFromPage(taskMeta) {
        if (!taskMeta?.id || !taskMeta?.url) return;
        const taskId = taskMeta.id;
        const now = Date.now();
        const tasks = readStarredTasks();
        const match = tasks.find(task => task.id === taskId);

        const latestInfo = getLastPostInfoFromDocument(document);
        if (latestInfo) {
            if (match) {
                match.lastPostTime = latestInfo.time;
                match.lastPostAuthor = latestInfo.author;
                match.lastPostText = trimText(latestInfo.text, 500);
            }
        }

        const approvedMinutes = getApprovedUniqueTimeFromDocument(document);
        if (match) {
            match.approvedTimeMinutes = approvedMinutes;
            if (match.hasNew) match.hasNew = false;
            writeStarredTasks(tasks);
        }

        const visitedTasks = readVisitedTasks();
        const visitedIndex = visitedTasks.findIndex(task => String(task.id) === String(taskId) || task.url === taskMeta.url);
        const baseTask = visitedIndex >= 0 ? visitedTasks[visitedIndex] : {};
        const visitedTask = {
            ...baseTask,
            name: taskMeta.name,
            url: taskMeta.url,
            client: taskMeta.client,
            id: taskMeta.id,
            lastVisitedAt: now,
            approvedTimeMinutes: approvedMinutes,
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
        renderStarredTasks();
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

    function setupHeader(name, id, client, nameSlug) {
        const h2 = document.querySelector('h2');
        const paramUrl = buildParamUrl(nameSlug, id, client);

        if (h2) {
            h2.className = 'u-text--red';
            h2.style.margin = '20px 10px';
            h2.innerHTML = `<span id="pbs-star-toggle" style="cursor:pointer;margin-right: 6px;font-size: 26px;color: #f2c200;position: absolute;left: 25px;top: 23px;" title="Sledovat úkol">☆</span>${name} <span href="${paramUrl}" id="quickCopy" style="cursor:pointer" title="Kopírovat URL">🔗</span>  <span style="font-size: smaller; float: right;">${client} #${id}</span>`;

            const quickCopy = document.getElementById('quickCopy');
            quickCopy.addEventListener('click', () => {
                navigator.clipboard.writeText(paramUrl).then(() => {
                    quickCopy.textContent = '✔';
                    setTimeout(() => {
                        quickCopy.textContent = '🔗';
                    }, 1000);
                });
            });

            const starToggle = document.getElementById('pbs-star-toggle');
            const updateStarIcon = (isStarred) => {
                starToggle.textContent = isStarred ? '★' : '☆';
            };

            const tasks = readStarredTasks();
            const isStarred = tasks.some(task => task.url === paramUrl);
            updateStarIcon(isStarred);

            starToggle.addEventListener('click', () => {
                const current = readStarredTasks();
                const existingIndex = current.findIndex(task => task.url === paramUrl);

                if (existingIndex >= 0) {
                    current.splice(existingIndex, 1);
                    updateStarIcon(false);
                } else {
                    const visitedMatch = readVisitedTasks().find(task => String(task.id) === String(id) || task.url === paramUrl);
                    current.push({
                        ...visitedMatch,
                        name,
                        url: paramUrl,
                        client,
                        id,
                        hasNew: Boolean(visitedMatch?.hasNew)
                    });
                    updateStarIcon(true);
                }

                writeStarredTasks(current);
                renderStarredTasks();
            });

            renderStarredTasks();
        }
        return h2;
    }
    function createUrlContainer(url) {
        const container = document.createElement('div');
        container.style.cssText = 'display: flex; align-items: center; margin: 10px; font-size: 12px; color: #666; gap: 8px;';

        const urlLink = document.createElement('a');
        urlLink.href = url;
        urlLink.textContent = url;
        urlLink.style.color = '#666';

        const copyButton = document.createElement('button');
        copyButton.textContent = 'Kopírovat';
        copyButton.style.cssText = 'cursor: pointer; padding: 2px 8px; font-size: 12px;';

        copyButton.addEventListener('click', () => {
            navigator.clipboard.writeText(url).then(() => {
                copyButton.textContent = 'Zkopírováno!';
                setTimeout(() => {
                    copyButton.textContent = 'Kopírovat';
                }, 2000);
            });
        });

        container.appendChild(urlLink);
        container.appendChild(copyButton);
        return container;
    }

    function setupUrlContainers(h2, data, nameSlug) {
        const clientSlug = createSlug(data.client);
        const prettyUrl = `https://pbs2.praguebest.cz/${clientSlug}/${nameSlug}/${data.id}`;
        const paramUrl = buildParamUrl(nameSlug, data.id, data.client);

        h2.after(createUrlContainer(paramUrl));
        h2.after(createUrlContainer(prettyUrl));
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
        newComment.innerHTML = `<div class="Grid"><div class="Grid-cell Post u-xs-size12of12 u-size10of12 u-lg-size12of12" style="border-color: #f50541;"><div class="post-header Post-headerContent" style="background-color: #f50541;"><div><a href="#note-0" class="anchor post-anchor">#0</a><div class="Post-address"><a class="post-author">Zadání</a></div></div></div><div class="Post-content"><div class="ck-content" id="commentText-0">${descContent}</div></div></div></div>`;

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
        return new Date(year, month - 1, day, hour, minute);
    }

    function handleVisitTracking(id) {
        const now = new Date();
        const lastVisitKey = `PBS_lastVisit_${id}`;
        const lastVisit = localStorage.getItem(lastVisitKey);
        localStorage.setItem(lastVisitKey, now.getTime().toString());

        if (!lastVisit) return 0;

        const comments = document.querySelectorAll('.post.js-note-post');
        const lastVisitTime = parseInt(lastVisit);
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

            notepad.parentNode.insertBefore(toggleLink, notepad);
        }, 250);
    }

    function improveFiles(){
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
        const iconMap = {
            pdf: 'fa-file-pdf',
            doc: 'fa-file-word',
            docx: 'fa-file-word',
            xls: 'fa-file-excel',
            xlsx: 'fa-file-excel',
            zip: 'fa-file-zipper',
            txt: 'fa-file-text',
            csv: 'fa-file-csv',
        };

        if (!document.querySelector('link[href*="font-awesome"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(link);
        }

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
            const filename = link.textContent;
            const status = container.querySelector('.progressBarStatus').textContent;
            const ext = filename.split('.').pop().toLowerCase();

            container.className = '';
            container.style.border = '1px solid lightgrey';
            container.style.padding = '10px';
            container.style.marginBottom = '5px';

            if (imageExtensions.includes(ext)) {
                container.innerHTML = `
        <div style="display: flex; gap: 1rem;">
          <a href="${href}" target="_blank" class="progressName" style="color: #c81b08;">
            <img src="${href}" alt="${filename}" style="max-width: 250px; height: 150px; object-fit: scale-down; border:1px solid #cccccc; border-radius: 4px;">
          </a>
          <div>
            <div><a href="${href}" target="_blank" class="progressName" style="color: #c81b08;">${filename}</a></div>
            <div style="font-size: 0.875rem; color: #666; margin: 0.5rem 0;">${status}</div>
            <a href="${href}" download="${filename}" class="btn btn-success">Stáhnout</a>
          </div>
        </div>
      `;
            } else {
                const icon = iconMap[ext] || 'fa-file';
                container.innerHTML = `
        <div style="display: flex; gap: 1rem; align-items: center;">
          <i class="fa-solid ${icon}" style="font-size: 2rem; color: #c81b08;"></i>
          <div>
            <a href="${href}" download="${filename}" class="progressName" style="color: #c81b08;">${filename}</a>
            <div style="font-size: 0.875rem; color: #666; margin: 0.5rem 0;">${status}</div>
          </div>
        </div>
      `;
            }
        });
    }

    function attachFilesToComments(){
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
        const iconMap = {
            pdf: 'fa-file-pdf',
            doc: 'fa-file-word',
            docx: 'fa-file-word',
            xls: 'fa-file-excel',
            xlsx: 'fa-file-excel',
            zip: 'fa-file-zipper',
            txt: 'fa-file-text',
            csv: 'fa-file-csv',
        };

        const filesData = [];

        document.querySelectorAll('.progressContainer').forEach(container => {
            const link = container.querySelector('.progressName a');
            if (!link) return;

            const href = link.getAttribute('href');
            const filename = link.textContent;
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

            const ext = fileData.filename.split('.').pop().toLowerCase();
            let fileHtml = '';

            if (imageExtensions.includes(ext)) {
                fileHtml = `
                <div style="display: flex; gap: 1rem;">
                    <a href="${fileData.href}" target="_blank" class="progressName" style="color: #c81b08;">
                        <img src="${fileData.href}" alt="${fileData.filename}" style="max-width: 250px; height: 150px; object-fit: scale-down; border:1px solid #cccccc; border-radius: 4px;">
                    </a>
                    <div>
                        <div><a href="${fileData.href}" target="_blank" class="progressName" style="color: #c81b08;">${fileData.filename}</a></div>
                        <a href="${fileData.href}" download="${fileData.filename}" class="btn btn-success">Stáhnout</a>
                    </div>
                </div>
            `;
            } else {
                const icon = iconMap[ext] || 'fa-file';
                fileHtml = `
                <div style="display: flex; gap: 1rem; align-items: center;">
                    <i class="fa-solid ${icon}" style="font-size: 2rem; color: #c81b08;"></i>
                    <div>
                        <a href="${fileData.href}" download="${fileData.filename}" class="progressName" style="color: #c81b08;">${fileData.filename}</a>
                    </div>
                </div>
            `;
            }

            const fileDiv = document.createElement('div');
            fileDiv.style.padding = '10px';
            fileDiv.style.marginTop = '10px';
            fileDiv.innerHTML = fileHtml;

            contentDiv.parentNode.insertBefore(fileDiv, contentDiv.nextSibling);
        });
    }
    function mixTimeAndRequests(){
        const myName = document.querySelector("#head > div > nav > div.Navigation-userBar.UserBar.js-navigation-userbar > div > a > span > strong")?.textContent.trim();
        if (!myName) return;

        const items = [];
        const myTimeTexts = [];

        document.querySelectorAll('#overtim .timr').forEach(el => {
            const time = el.querySelector('.timrc')?.textContent.trim();
            const date = el.querySelector('.timrd')?.textContent.trim();
            const description = el.querySelector('.timrds')?.textContent.trim();

            if (time && date && description) {
                myTimeTexts.push(description);
                const dateObj = new Date(date.replace(' ', ' '));
                items.push({
                    time,
                    date,
                    description,
                    type: 'myTime',
                    dateObj,
                    element: el
                });
            }
        });

        document.querySelectorAll('#othth').forEach(heading => {
            if (heading.textContent.includes('Žádosti')) {
                let current = heading.nextElementSibling;
                while (current && !current.id) {
                    if (current.classList.contains('timr')) {
                        const time = current.querySelector('.timrc')?.textContent.trim();
                        const date = current.querySelector('.timrd')?.textContent.trim();
                        const person = current.querySelector('.timru')?.textContent.trim();
                        const descEls = current.querySelectorAll('.timrds');
                        const description = descEls[0]?.textContent.trim();
                        const status = descEls[1]?.textContent.trim();

                        if (person?.includes(myName) && time && date && description && !myTimeTexts.includes(description)) {
                            const dateObj = new Date(date.replace(' ', ' '));
                            items.push({
                                time,
                                date,
                                description,
                                status,
                                type: 'request',
                                dateObj,
                                element: current
                            });
                        }
                    }
                    current = current.nextElementSibling;
                }
            }
        });

        items.sort((a, b) => b.dateObj - a.dateObj);

        const container = document.querySelector('#overtim');
        container.innerHTML = '';

        items.forEach(item => {
            const clone = item.element.cloneNode(true);

            if (item.type === 'request') {
                const borderColor = item.status?.includes('Schváleno') ? '#4CAF50' : '#FF9800';
                clone.style.borderLeft = `4px solid ${borderColor}`;
                clone.style.paddingLeft = '10px';
            }

            container.appendChild(clone);
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
        document.getElementById("environment").remove();
        document.querySelectorAll("#head > div > nav > div.Navigation-userBar.UserBar.js-navigation-userbar > div > a > span > small:nth-child(2)").forEach(element => {
            element.style.float= "left";
            element.style.color= "black";
            element.style.marginRight= "3px;";
        });


        window.addEventListener('scroll', () => {
            const currentScroll = window.pageYOffset || document.documentElement.scrollTop;

            if (currentScroll > lastScrollTop) {
                head.style.transform = 'translateY(-100%)';
            } else {
                head.style.transform = 'translateY(0)';
            }

            lastScrollTop = currentScroll <= 0 ? 0 : currentScroll;
        });
    }

    function hideSystemComments(){
        document.querySelectorAll('.post.js-note-post').forEach(comment => {
            const content = comment.querySelector('.ck-content');
            if (!content) return;

            const text = content.innerHTML.trim();

            if (isSystemCommentContent(text)) {
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

        const data = extractTableData();
        if (!data) return;

        const nameSlug = createSlug(data.name);
        const h2 = setupHeader(data.name, data.id, data.client, nameSlug);

        if (h2) {
            //  setupUrlContainers(h2, data, nameSlug);
        }

        cleanupElements();
        handleDescriptionContent();
        reorganizeDOM();
        updateUrlParams(nameSlug, data.client, data.id);
        const currentTaskMeta = {
            id: data.id,
            name: data.name,
            client: data.client,
            url: buildParamUrl(nameSlug, data.id, data.client)
        };
        handleVisitTracking(data.id);
        updateCurrentTaskFromPage(currentTaskMeta);
        addVykazatButtonsToApprovedRows();
        hideNotes();
        attachFilesToComments();
        improveFiles();
        checkStarredTasksForUpdates();
        //mixTimeAndRequests();

        addBodyStyles();
        initHeaderScroll();
        hideSystemComments();
    }

    init();
})();
