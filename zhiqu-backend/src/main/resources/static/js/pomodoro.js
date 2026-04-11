(function () {
    const WORK_OPTIONS = [15, 25, 30, 45];
    const SHORT_BREAK_SEC = 5 * 60;
    const LONG_BREAK_SEC = 15 * 60;

    let phase = 'idle';
    let timerId = null;
    let remainingSec = 0;
    let totalPhaseSec = 0;
    let pomosCompletedInSet = 0;
    let paused = false;
    let audioCtx = null;

    function todayKey() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function readTodayStats() {
        try {
            const raw = localStorage.getItem('zhiqu_pomo_' + todayKey());
            return raw ? JSON.parse(raw) : { count: 0, minutes: 0 };
        } catch (e) {
            return { count: 0, minutes: 0 };
        }
    }

    function writeTodayStats(s) {
        localStorage.setItem('zhiqu_pomo_' + todayKey(), JSON.stringify(s));
    }

    function bumpTodayStats(minutes) {
        const s = readTodayStats();
        s.count = (s.count || 0) + 1;
        s.minutes = (s.minutes || 0) + minutes;
        writeTodayStats(s);
        updateTodayDisplay();
    }

    function updateTodayDisplay() {
        const el = document.getElementById('pomo-today');
        if (!el) return;
        const s = readTodayStats();
        el.textContent = '今日：' + s.count + ' 个｜' + s.minutes + ' 分钟';
    }

    function playBeep() {
        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            const ctx = audioCtx;
            if (ctx.state === 'suspended') {
                ctx.resume();
            }
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            osc.type = 'square';
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
        } catch (e) {
            /* ignore */
        }
    }

    function notify(title, body) {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(title, { body });
        }
    }

    function requestNotifyPermission() {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    function getWorkDurationSec() {
        const sel = document.getElementById('pomo-work-duration');
        const m = sel ? parseInt(sel.value, 10) : 25;
        return (WORK_OPTIONS.includes(m) ? m : 25) * 60;
    }

    function getSelectedTaskId() {
        const sel = document.getElementById('pomo-task');
        if (!sel || !sel.value) return null;
        const id = parseInt(sel.value, 10);
        return Number.isFinite(id) ? id : null;
    }

    function setRingColor(isWork) {
        const fg = document.getElementById('pomo-ring-fg');
        if (fg) {
            fg.setAttribute('stroke', isWork ? '#409EFF' : '#67C23A');
        }
    }

    function updateRing() {
        const circle = document.getElementById('pomo-ring-fg');
        if (!circle || !totalPhaseSec) return;
        const r = parseFloat(circle.getAttribute('r')) || 80;
        const c = 2 * Math.PI * r;
        const ratio = remainingSec / totalPhaseSec;
        const offset = c * (1 - ratio);
        circle.style.strokeDasharray = String(c);
        circle.style.strokeDashoffset = String(offset);
    }

    function formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    function updateUi() {
        const timeEl = document.getElementById('pomo-time');
        const phaseEl = document.getElementById('pomo-phase');
        const roundEl = document.getElementById('pomo-round');
        if (timeEl) timeEl.textContent = formatTime(Math.max(0, remainingSec));
        if (phaseEl) {
            if (phase === 'work') phaseEl.textContent = '专注中';
            else if (phase === 'shortBreak' || phase === 'longBreak') phaseEl.textContent = '休息中';
            else phaseEl.textContent = '待开始';
        }
        if (roundEl) {
            if (phase === 'work') {
                roundEl.textContent = '第 ' + (pomosCompletedInSet + 1) + '/4 个番茄';
            } else {
                roundEl.textContent = '';
            }
        }
        updateRing();
        const btnStart = document.getElementById('pomo-start');
        const btnPause = document.getElementById('pomo-pause');
        const btnResume = document.getElementById('pomo-resume');
        const btnReset = document.getElementById('pomo-reset');
        const btnSkip = document.getElementById('pomo-skip');
        if (btnStart) btnStart.disabled = phase !== 'idle';
        if (btnPause) btnPause.disabled = phase === 'idle' || paused;
        if (btnResume) btnResume.disabled = !paused || phase === 'idle';
        if (btnReset) btnReset.disabled = false;
        if (btnSkip) btnSkip.disabled = phase === 'idle';
    }

    function clearTimer() {
        if (timerId) {
            clearInterval(timerId);
            timerId = null;
        }
    }

    async function recordStudySession(minutes) {
        const taskId = getSelectedTaskId();
        const studyDate = todayKey();
        try {
            await api.post('/record', {
                taskId,
                studyDate,
                durationMinutes: minutes,
                note: '番茄钟专注时段'
            });
        } catch (e) {
            showToast(e.message || '学习记录失败', 'error');
        }
    }

    function finishWorkPhase() {
        clearTimer();
        const minutes = Math.round(getWorkDurationSec() / 60);
        bumpTodayStats(minutes);
        recordStudySession(minutes);
        playBeep();
        notify('番茄钟', '专注时段结束，休息一下吧！');
        pomosCompletedInSet++;
        if (pomosCompletedInSet >= 4) {
            pomosCompletedInSet = 0;
            startBreakPhase('longBreak', LONG_BREAK_SEC);
        } else {
            startBreakPhase('shortBreak', SHORT_BREAK_SEC);
        }
    }

    function finishBreakPhase() {
        clearTimer();
        phase = 'idle';
        remainingSec = 0;
        totalPhaseSec = 0;
        paused = false;
        setRingColor(true);
        playBeep();
        notify('番茄钟', '休息结束，继续加油！');
        updateUi();
    }

    function startBreakPhase(kind, sec) {
        phase = kind;
        remainingSec = sec;
        totalPhaseSec = sec;
        paused = false;
        setRingColor(false);
        timerId = setInterval(tick, 1000);
        updateUi();
    }

    function tick() {
        if (paused) return;
        remainingSec--;
        if (remainingSec <= 0) {
            if (phase === 'work') {
                finishWorkPhase();
            } else if (phase === 'shortBreak' || phase === 'longBreak') {
                finishBreakPhase();
            }
            return;
        }
        updateUi();
    }

    function startWork() {
        requestNotifyPermission();
        clearTimer();
        phase = 'work';
        remainingSec = getWorkDurationSec();
        totalPhaseSec = remainingSec;
        paused = false;
        setRingColor(true);
        timerId = setInterval(tick, 1000);
        updateUi();
    }

    function pauseTimer() {
        paused = true;
        updateUi();
    }

    function resumeTimer() {
        paused = false;
        updateUi();
    }

    function resetAll() {
        clearTimer();
        phase = 'idle';
        remainingSec = 0;
        totalPhaseSec = 0;
        paused = false;
        setRingColor(true);
        updateUi();
    }

    function skipPhase() {
        if (phase === 'idle') return;
        clearTimer();
        if (phase === 'work') {
            phase = 'idle';
            remainingSec = 0;
            totalPhaseSec = 0;
            paused = false;
            setRingColor(true);
            updateUi();
            showToast('已跳过专注时段（未记录）', 'info');
        } else if (phase === 'shortBreak' || phase === 'longBreak') {
            finishBreakPhase();
        }
    }

    window.setPomodoroTasks = function (tasks) {
        const sel = document.getElementById('pomo-task');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">（不指定任务）</option>';
        (tasks || []).forEach((t) => {
            if (t.status === 2) return;
            const opt = document.createElement('option');
            opt.value = String(t.id);
            opt.textContent = t.title;
            sel.appendChild(opt);
        });
        if (current) sel.value = current;
    };

    window.initPomodoro = function () {
        updateTodayDisplay();
        const dur = document.getElementById('pomo-work-duration');
        if (dur && !dur.options.length) {
            WORK_OPTIONS.forEach((m) => {
                const o = document.createElement('option');
                o.value = String(m);
                o.textContent = m + ' 分钟';
                if (m === 25) o.selected = true;
                dur.appendChild(o);
            });
        }
        document.getElementById('pomo-start')?.addEventListener('click', () => {
            if (phase === 'idle') startWork();
        });
        document.getElementById('pomo-pause')?.addEventListener('click', pauseTimer);
        document.getElementById('pomo-resume')?.addEventListener('click', resumeTimer);
        document.getElementById('pomo-reset')?.addEventListener('click', resetAll);
        document.getElementById('pomo-skip')?.addEventListener('click', skipPhase);
        window.addEventListener('beforeunload', clearTimer);
        const circle = document.getElementById('pomo-ring-fg');
        if (circle) {
            const r = parseFloat(circle.getAttribute('r')) || 80;
            const c = 2 * Math.PI * r;
            circle.style.strokeDasharray = String(c);
            circle.style.strokeDashoffset = String(c);
        }
        updateUi();
    };
})();
