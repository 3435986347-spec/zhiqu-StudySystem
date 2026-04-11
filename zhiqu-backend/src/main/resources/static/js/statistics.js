checkAuth();
renderNavbar('navbar');

let trendChart;
let pieChart;
let statsData;

function renderStatCards(data) {
    const el = document.getElementById('stat-cards');
    if (!data) return;
    const items = [
        { label: '连续学习天数', value: data.consecutiveDays ?? 0 },
        { label: '总学习时长（分钟）', value: data.totalStudyMinutes ?? 0 },
        { label: '完成任务数', value: data.completedTaskCount ?? 0 },
        { label: '总任务数', value: data.totalTaskCount ?? 0 }
    ];
    el.innerHTML = items
        .map(
            (i) =>
                '<div class="stat-card"><div class="value">' +
                i.value +
                '</div><div class="label">' +
                i.label +
                '</div></div>'
        )
        .join('');
}

function pieFromStats(data) {
    const dist = data && data.quadrantDistribution ? data.quadrantDistribution : {};
    return [1, 2, 3, 4].map((q) => ({
        name: quadrantLabel(q),
        value: Number(dist[q] != null ? dist[q] : dist[String(q)] || 0)
    }));
}

function renderPie() {
    if (!pieChart) {
        pieChart = echarts.init(document.getElementById('chart-pie'));
    }
    const option = {
        tooltip: { trigger: 'item' },
        series: [
            {
                type: 'pie',
                radius: ['40%', '70%'],
                data: pieFromStats(statsData),
                emphasis: {
                    itemStyle: {
                        shadowBlur: 10,
                        shadowOffsetX: 0,
                        shadowColor: 'rgba(0, 0, 0, 0.2)'
                    }
                }
            }
        ]
    };
    pieChart.setOption(option);
}

async function loadTrend(type) {
    const res = await api.get('/record/trend?type=' + encodeURIComponent(type));
    const list = res.data || [];
    if (!trendChart) {
        trendChart = echarts.init(document.getElementById('chart-trend'));
    }
    const xs = list.map((x) => x.period);
    const ys = list.map((x) => x.minutes);
    trendChart.setOption({
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: xs, axisLabel: { rotate: xs.some((s) => String(s).length > 8) ? 30 : 0 } },
        yAxis: { type: 'value', name: '分钟' },
        series: [{ type: 'line', smooth: true, data: ys, areaStyle: { opacity: 0.12 }, itemStyle: { color: '#409eff' } }]
    });
}

async function loadAll() {
    const res = await api.get('/record/statistics');
    statsData = res.data;
    renderStatCards(statsData);
    renderPie();
    await loadTrend('day');
}

document.querySelectorAll('.trend-tabs button').forEach((btn) => {
    btn.addEventListener('click', async () => {
        document.querySelectorAll('.trend-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        try {
            await loadTrend(btn.dataset.type);
        } catch (e) {
            showToast(e.message || '加载趋势失败', 'error');
        }
    });
});

window.addEventListener('resize', () => {
    trendChart && trendChart.resize();
    pieChart && pieChart.resize();
});

document.addEventListener('DOMContentLoaded', () => {
    loadAll().catch((e) => showToast(e.message || '加载失败', 'error'));
});
