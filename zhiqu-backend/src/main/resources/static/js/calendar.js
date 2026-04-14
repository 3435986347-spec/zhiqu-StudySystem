/* ═══════════════════════════════════════════
   calendar.js — Month-view Task Calendar
   ═══════════════════════════════════════════ */

(function () {
    /* ── State ── */
    var today = new Date();
    var viewYear  = today.getFullYear();
    var viewMonth = today.getMonth(); // 0-indexed
    var allTasks  = [];
    var selectedDate = null; // 'YYYY-MM-DD'

    /* ── Quadrant colors (matches CSS vars) ── */
    var Q_COLORS = {
        1: '#EF5B5B',
        2: '#5B8DEF',
        3: '#F5A623',
        4: '#52C77A'
    };
    var Q_LABELS = {
        1: '重要且紧急',
        2: '重要不紧急',
        3: '紧急不重要',
        4: '不重要不紧急'
    };
    var STATUS_LABELS = { 0: '待办', 1: '进行中', 2: '已完成' };

    /* ── Public API ── */
    window.initCalendar = function () {
        buildCalendarShell();
        bindCalendarNav();
        // Tasks will be provided via refreshCalendar() once loaded
    };

    window.refreshCalendar = function (tasks) {
        if (tasks !== undefined) {
            allTasks = tasks || [];
        }
        renderMonth();
        if (selectedDate) renderDetail(selectedDate);
        renderMonthStats();
    };

    /* ── Build DOM skeleton ── */
    function buildCalendarShell() {
        var el = document.getElementById('cal-panel');
        if (!el) return;

        el.innerHTML =
            '<div class="cal-header">' +
            '  <button type="button" class="cal-nav" id="cal-prev" title="上个月">&#8249;</button>' +
            '  <div class="cal-title" id="cal-title"></div>' +
            '  <button type="button" class="cal-nav" id="cal-next" title="下个月">&#8250;</button>' +
            '</div>' +
            '<button type="button" class="cal-today-btn" id="cal-today">今天</button>' +
            '<div class="cal-weekdays">' +
            '  <span>日</span><span>一</span><span>二</span><span>三</span>' +
            '  <span>四</span><span>五</span><span>六</span>' +
            '</div>' +
            '<div class="cal-grid" id="cal-grid"></div>' +
            '<div class="cal-detail" id="cal-detail"></div>' +
            '<div class="cal-month-stats" id="cal-month-stats"></div>';

        renderMonth();
        renderMonthStats();
    }

    function bindCalendarNav() {
        document.addEventListener('click', function (e) {
            if (e.target.id === 'cal-prev') { prevMonth(); }
            if (e.target.id === 'cal-next') { nextMonth(); }
            if (e.target.id === 'cal-today') { goToday(); }
        });
    }

    /* ── Navigation ── */
    function prevMonth() {
        viewMonth--;
        if (viewMonth < 0) { viewMonth = 11; viewYear--; }
        selectedDate = null;
        renderMonth();
        renderDetail(null);
        renderMonthStats();
    }
    function nextMonth() {
        viewMonth++;
        if (viewMonth > 11) { viewMonth = 0; viewYear++; }
        selectedDate = null;
        renderMonth();
        renderDetail(null);
        renderMonthStats();
    }
    function goToday() {
        var now = new Date();
        viewYear  = now.getFullYear();
        viewMonth = now.getMonth();
        selectedDate = null;
        renderMonth();
        renderDetail(null);
        renderMonthStats();
    }

    /* ── Render month grid ── */
    function renderMonth() {
        var titleEl = document.getElementById('cal-title');
        var gridEl  = document.getElementById('cal-grid');
        if (!titleEl || !gridEl) return;

        var monthNames = ['一月','二月','三月','四月','五月','六月',
                          '七月','八月','九月','十月','十一月','十二月'];
        titleEl.textContent = viewYear + ' · ' + monthNames[viewMonth];

        /* Build task map: 'YYYY-MM-DD' → [task, ...] */
        var taskMap = buildTaskMap();

        /* First day of month and total days */
        var firstDay = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
        var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        var todayStr = dateStr(new Date());

        var html = '';

        /* Leading empty cells */
        for (var i = 0; i < firstDay; i++) {
            html += '<div class="cal-cell cal-cell-empty"></div>';
        }

        /* Day cells */
        for (var d = 1; d <= daysInMonth; d++) {
            var ds  = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(d);
            var tasks = taskMap[ds] || [];
            var isToday = (ds === todayStr);
            var isSel   = (ds === selectedDate);

            var cls = 'cal-cell';
            if (isToday) cls += ' cal-cell-today';
            if (isSel)   cls += ' cal-cell-selected';
            if (tasks.length) cls += ' cal-cell-has-tasks';

            html += '<div class="' + cls + '" data-date="' + ds + '">';
            html += '<span class="cal-day-num">' + d + '</span>';

            /* Task dots — max 3 rows, then overflow */
            var shown = Math.min(tasks.length, 3);
            for (var t = 0; t < shown; t++) {
                var task = tasks[t];
                var dotColor = Q_COLORS[task.quadrant] || '#888';
                var taskTitle = escHtml(task.title);
                var hm = extractHm(task.startTime);
                var timeSpan = hm ? '<span class="cal-task-time">' + hm + '</span>' : '';
                var repeatMark = task.repeatGroupId ? '<span class="cal-task-repeat" title="周期重复">🔁</span>' : '';
                var titleAttr = (hm ? hm + ' ' : '') + taskTitle +
                    (task.repeatWeekNumber && task.repeatWeeks
                        ? ' (第' + task.repeatWeekNumber + '/' + task.repeatWeeks + '周)'
                        : '');
                html +=
                    '<div class="cal-task-row" style="--dot-color:' + dotColor + '" title="' + titleAttr + '">' +
                    '<span class="cal-dot"></span>' +
                    timeSpan +
                    repeatMark +
                    '<span class="cal-task-name">' + taskTitle + '</span>' +
                    '</div>';
            }
            if (tasks.length > 3) {
                html += '<div class="cal-overflow">+' + (tasks.length - 3) + ' 更多</div>';
            }

            html += '</div>';
        }

        /* Trailing empty cells to complete last row */
        var totalCells = firstDay + daysInMonth;
        var rem = totalCells % 7;
        if (rem !== 0) {
            for (var j = 0; j < (7 - rem); j++) {
                html += '<div class="cal-cell cal-cell-empty"></div>';
            }
        }

        gridEl.innerHTML = html;

        /* Click handler */
        gridEl.querySelectorAll('.cal-cell[data-date]').forEach(function (cell) {
            cell.addEventListener('click', function () {
                var date = this.getAttribute('data-date');
                if (selectedDate === date) {
                    /* Toggle off */
                    selectedDate = null;
                    renderMonth();
                    renderDetail(null);
                } else {
                    selectedDate = date;
                    renderMonth();
                    renderDetail(date);
                }
            });
        });
    }

    /* ── Detail panel ── */
    function renderDetail(dateStr) {
        var el = document.getElementById('cal-detail');
        if (!el) return;

        if (!dateStr) {
            el.innerHTML = '';
            el.classList.remove('visible');
            return;
        }

        var taskMap = buildTaskMap();
        var tasks = taskMap[dateStr] || [];

        var parts = dateStr.split('-');
        var label = parts[0] + ' 年 ' + parseInt(parts[1]) + ' 月 ' + parseInt(parts[2]) + ' 日';

        if (!tasks.length) {
            el.innerHTML =
                '<div class="cal-detail-header">' + label + '</div>' +
                '<div class="cal-detail-empty">当日无任务</div>';
            el.classList.add('visible');
            return;
        }

        var html =
            '<div class="cal-detail-header">' + label +
            ' <span class="cal-detail-count">' + tasks.length + ' 项</span></div>';

        tasks.forEach(function (task) {
            var color  = Q_COLORS[task.quadrant] || '#888';
            var qLabel = Q_LABELS[task.quadrant] || '';
            var stLabel = STATUS_LABELS[task.status] || '';
            var stCls  = task.status === 2 ? 'cal-det-done' : task.status === 1 ? 'cal-det-doing' : '';

            /* 时间段显示 */
            var timeLine = '';
            if (task.startTime) {
                var startHm = extractHm(task.startTime);
                if (task.durationMinutes) {
                    var startMs = new Date(String(task.startTime).replace(' ', 'T')).getTime();
                    if (!isNaN(startMs)) {
                        var endDate = new Date(startMs + task.durationMinutes * 60000);
                        var endHm = pad(endDate.getHours()) + ':' + pad(endDate.getMinutes());
                        timeLine = '🕐 ' + startHm + ' - ' + endHm +
                                   '（' + fmtDuration(task.durationMinutes) + '）';
                    } else {
                        timeLine = '🕐 ' + startHm + ' 开始';
                    }
                } else {
                    timeLine = '🕐 ' + startHm + ' 开始';
                }
            } else if (task.deadline) {
                timeLine = '⏰ 截止 ' + extractHm(task.deadline);
            }

            var weekInfo = (task.repeatWeekNumber && task.repeatWeeks)
                ? ' · <span class="cal-det-repeat">🔁 第' + task.repeatWeekNumber + '/' + task.repeatWeeks + '周</span>'
                : '';

            html +=
                '<div class="cal-detail-item ' + stCls + '" style="--q-color:' + color + '">' +
                '<span class="cal-det-q-bar"></span>' +
                '<div class="cal-det-body">' +
                '<div class="cal-det-title">' + escHtml(task.title) + '</div>' +
                (timeLine ? '<div class="cal-det-time">' + timeLine + '</div>' : '') +
                '<div class="cal-det-meta">' + qLabel + ' · ' + stLabel + weekInfo + '</div>' +
                '</div>' +
                '</div>';
        });

        el.innerHTML = html;
        el.classList.add('visible');
    }

    /* ── Month stats ── */
    function renderMonthStats() {
        var el = document.getElementById('cal-month-stats');
        if (!el) return;

        var taskMap = buildTaskMap();
        var total = 0, done = 0;
        Object.keys(taskMap).forEach(function (ds) {
            if (!ds.startsWith(viewYear + '-' + pad(viewMonth + 1))) return;
            taskMap[ds].forEach(function (t) {
                total++;
                if (t.status === 2) done++;
            });
        });

        if (!total) {
            el.innerHTML = '';
            return;
        }
        var pct = Math.round(done / total * 100);
        el.innerHTML =
            '<div class="cal-stats-row">' +
            '<span>本月截止任务：<strong>' + total + '</strong></span>' +
            '<span>已完成：<strong>' + done + '</strong>（' + pct + '%）</span>' +
            '</div>' +
            '<div class="cal-stats-bar"><div class="cal-stats-fill" style="width:' + pct + '%"></div></div>';
    }

    /* ── Helpers ── */
    function buildTaskMap() {
        var map = {};
        allTasks.forEach(function (task) {
            // 优先用 startTime 的日期，没有则用 deadline 的日期
            var basis = task.startTime || task.deadline;
            if (!basis) return;
            var ds = String(basis).substring(0, 10);
            if (!map[ds]) map[ds] = [];
            map[ds].push(task);
        });
        // 每天内部按 startTime（或 deadline）升序排序
        Object.keys(map).forEach(function (ds) {
            map[ds].sort(function (a, b) {
                var ta = a.startTime || a.deadline || '';
                var tb = b.startTime || b.deadline || '';
                return String(ta).localeCompare(String(tb));
            });
        });
        return map;
    }

    /** 从 "YYYY-MM-DD HH:mm:ss" 或 ISO 提取 "HH:mm" */
    function extractHm(str) {
        if (!str) return '';
        var s = String(str).replace('T', ' ');
        // 期望格式 "YYYY-MM-DD HH:mm..."
        if (s.length < 16) return '';
        return s.substring(11, 16);
    }

    /** 格式化持续时长 → "1h30m" / "45m" */
    function fmtDuration(m) {
        if (m == null) return '';
        if (m >= 60) {
            var h  = Math.floor(m / 60);
            var mm = m % 60;
            return mm > 0 ? h + 'h' + mm + 'm' : h + 'h';
        }
        return m + 'm';
    }

    function dateStr(d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function pad(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    function escHtml(s) {
        return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
})();
