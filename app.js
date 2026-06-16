// ---------- 数据库初始化 ----------
const db = new Dexie("QuantReviewDB");
db.version(1).stores({
  trades: "++id, date, code, name, direction, side, price, volume, amount, fee, formulaName, note",
  scores: "++id, date, code, name, daPan, banKuai, jiShu, liangJia, qingXu, score, plan",
  formulaSignals: "++id, date, formulaName, stock, result, days, pnlRatio",
  mistakes: "++id, date, stock, type, desc, rule, fix",
  formulas: "++id, name"
});

// 默认公式名称
const defaultFormulas = ["倍量突破MA20", "MACD零上金叉", "涨停板回调", "均线多头排列", "量价背离"];

// ---------- 全局变量 ----------
let currentTab = "dashboard";
let pnlChart = null;

// ---------- 页面加载 ----------
document.addEventListener("DOMContentLoaded", async () => {
  await initFormulas();
  setupNavigation();
  setupForms();
  setupImportExport();
  await refreshAll();
});

async function initFormulas() {
  const count = await db.formulas.count();
  if (count === 0) {
    await db.formulas.bulkAdd(defaultFormulas.map(name => ({ name })));
  }
}

// ---------- 导航 ----------
function setupNavigation() {
  document.querySelectorAll(".bottom-nav button").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const tab = e.target.closest("button").dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-content").forEach(s => s.classList.remove("active"));
  document.getElementById(tab).classList.add("active");
  document.querySelectorAll(".bottom-nav button").forEach(b => b.classList.remove("active"));
  document.querySelector(`.bottom-nav button[data-tab="${tab}"]`).classList.add("active");
  refreshTab(tab);
}

async function refreshTab(tab) {
  switch(tab) {
    case "dashboard": await loadDashboard(); break;
    case "trades": await loadTrades(); break;
    case "scores": await loadScores(); break;
    case "formulas": await loadFormulas(); break;
    case "mistakes": await loadMistakes(); break;
  }
}

async function refreshAll() {
  await refreshTab(currentTab);
}

// ---------- 仪表盘 ----------
async function loadDashboard() {
  // 累计收益（简化为所有卖出金额 - 买入金额 - 手续费，忽略持仓浮动盈亏）
  const trades = await db.trades.toArray();
  let totalPnL = 0;
  let buyAmount = 0, sellAmount = 0;
  trades.forEach(t => {
    const amt = t.price * t.volume;
    if (t.side === "买入") buyAmount += amt + (t.fee || 0);
    else sellAmount += amt - (t.fee || 0);
  });
  totalPnL = sellAmount - buyAmount;
  document.getElementById("totalPnL").textContent = totalPnL.toFixed(2);

  // 胜率基于公式信号
  const signals = await db.formulaSignals.where("result").equals("成功").count();
  const totalSignals = await db.formulaSignals.count();
  const winRate = totalSignals > 0 ? ((signals / totalSignals) * 100).toFixed(1) + "%" : "0%";
  document.getElementById("winRate").textContent = winRate;

  // 当前持仓（买入-卖出同一代码）
  const holdings = {};
  trades.forEach(t => {
    if (!holdings[t.code]) holdings[t.code] = { name: t.name, volume: 0 };
    if (t.side === "买入") holdings[t.code].volume += t.volume;
    else holdings[t.code].volume -= t.volume;
  });
  const holdingCodes = Object.values(holdings).filter(h => h.volume > 0).length;
  document.getElementById("holdingCount").textContent = holdingCodes;

  // 资金曲线（按日期累计）
  await drawPnlChart(trades);
}

async function drawPnlChart(trades) {
  const ctx = document.getElementById("pnlChart").getContext("2d");
  if (pnlChart) pnlChart.destroy();

  // 按日期排序计算每日盈亏
  const dateMap = new Map();
  trades.sort((a,b) => a.date.localeCompare(b.date));
  let runningPnL = 0;
  trades.forEach(t => {
    const amt = t.price * t.volume;
    const net = t.side === "买入" ? -(amt + (t.fee || 0)) : (amt - (t.fee || 0));
    runningPnL += net;
    if (!dateMap.has(t.date)) dateMap.set(t.date, runningPnL);
    else dateMap.set(t.date, runningPnL);
  });
  const dates = Array.from(dateMap.keys()).slice(-30);
  const pnls = dates.map(d => dateMap.get(d));

  pnlChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: dates,
      datasets: [{
        label: "累计收益",
        data: pnls,
        borderColor: "#16213e",
        backgroundColor: "rgba(22,33,62,0.1)",
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  });
}

// ---------- 交易流水 ----------
async function loadTrades() {
  const trades = await db.trades.reverse().toArray();
  const container = document.getElementById("tradeList");
  container.innerHTML = trades.map(t => `
    <div class="list-item">
      <button class="delete-btn" onclick="deleteTrade(${t.id})">✕</button>
      <div><strong>${t.date} ${t.name}(${t.code})</strong> ${t.direction} ${t.side}</div>
      <div>价格: ${t.price} 数量: ${t.volume} 金额: ${(t.price*t.volume).toFixed(2)} 手续费: ${t.fee}</div>
      <div>公式: ${t.formulaName || "无"} 备注: ${t.note || ""}</div>
    </div>
  `).join("");

  // 更新公式下拉菜单
  const formulas = await db.formulas.toArray();
  const select = document.getElementById("tradeFormula");
  select.innerHTML = formulas.map(f => `<option value="${f.name}">${f.name}</option>`).join("");
}

async function deleteTrade(id) {
  if (confirm("确认删除？")) {
    await db.trades.delete(id);
    await loadTrades();
    await loadDashboard();
  }
}

// ---------- 多维评分 ----------
async function loadScores() {
  const scores = await db.scores.reverse().toArray();
  const container = document.getElementById("scoreList");
  container.innerHTML = scores.map(s => `
    <div class="list-item">
      <button class="delete-btn" onclick="deleteScore(${s.id})">✕</button>
      <div><strong>${s.date} ${s.name}(${s.code})</strong></div>
      <div>大盘:${s.daPan} 板块:${s.banKuai} 技术:${s.jiShu} 量价:${s.liangJia} 情绪:${s.qingXu} | 综合:${s.score.toFixed(1)}</div>
      <div>预案: ${s.plan || "无"}</div>
    </div>
  `).join("");
}

async function deleteScore(id) {
  if (confirm("确认删除？")) {
    await db.scores.delete(id);
    await loadScores();
  }
}

// ---------- 公式统计 ----------
async function loadFormulas() {
  const signals = await db.formulaSignals.reverse().toArray();
  const container = document.getElementById("formulaList");
  container.innerHTML = signals.map(s => `
    <div class="list-item">
      <button class="delete-btn" onclick="deleteSignal(${s.id})">✕</button>
      <div><strong>${s.date} ${s.formulaName}</strong> ${s.stock} | ${s.result}</div>
      <div>持有天数: ${s.days || "-"} 盈亏比: ${s.pnlRatio || "-"}</div>
    </div>
  `).join("");

  // 汇总
  const total = signals.length;
  const success = signals.filter(s => s.result === "成功").length;
  const winRate = total > 0 ? (success/total*100).toFixed(1) : 0;
  const avgPnL = total > 0 ? (signals.reduce((sum,s)=> sum + (s.pnlRatio||0), 0) / total).toFixed(2) : 0;
  document.getElementById("formulaSummary").innerHTML = `
    <h3>公式表现</h3>
    <p>总信号: ${total} | 成功: ${success} | 胜率: ${winRate}% | 平均盈亏比: ${avgPnL}</p>
  `;

  // 公式下拉
  const formulas = await db.formulas.toArray();
  const select = document.getElementById("sigFormulaName");
  select.innerHTML = formulas.map(f => `<option value="${f.name}">${f.name}</option>`).join("");
}

async function deleteSignal(id) {
  if (confirm("确认删除？")) {
    await db.formulaSignals.delete(id);
    await loadFormulas();
    await loadDashboard();
  }
}

// ---------- 错误清单 ----------
async function loadMistakes() {
  const mistakes = await db.mistakes.reverse().toArray();
  const container = document.getElementById("mistakeList");
  container.innerHTML = mistakes.map(m => `
    <div class="list-item">
      <button class="delete-btn" onclick="deleteMistake(${m.id})">✕</button>
      <div><strong>${m.date} ${m.stock}</strong> [${m.type}]</div>
      <div>${m.desc || ""}</div>
      <div>违反: ${m.rule || ""} | 改进: ${m.fix || ""}</div>
    </div>
  `).join("");
}

async function deleteMistake(id) {
  if (confirm("确认删除？")) {
    await db.mistakes.delete(id);
    await loadMistakes();
  }
}

// ---------- 表单提交 ----------
function setupForms() {
  document.getElementById("tradeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    await db.trades.add({
      date: form.tradeDate.value,
      code: form.tradeCode.value,
      name: form.tradeName.value,
      direction: form.tradeDirection.value,
      side: form.tradeSide.value,
      price: +form.tradePrice.value,
      volume: +form.tradeVolume.value,
      fee: +form.tradeFee.value,
      formulaName: form.tradeFormula.value,
      note: form.tradeNote.value
    });
    form.reset();
    await loadTrades();
    await loadDashboard();
  });

  document.getElementById("scoreForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const daPan = +document.getElementById("daPan").value;
    const banKuai = +document.getElementById("banKuai").value;
    const jiShu = +document.getElementById("jiShu").value;
    const liangJia = +document.getElementById("liangJia").value;
    const qingXu = +document.getElementById("qingXu").value;
    const score = (daPan + banKuai + jiShu + liangJia + qingXu) / 5;
    await db.scores.add({
      date: document.getElementById("scoreDate").value,
      code: document.getElementById("scoreCode").value,
      name: document.getElementById("scoreName").value,
      daPan, banKuai, jiShu, liangJia, qingXu, score,
      plan: document.getElementById("scorePlan").value
    });
    e.target.reset();
    await loadScores();
  });

  document.getElementById("formulaSignalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await db.formulaSignals.add({
      date: document.getElementById("sigDate").value,
      formulaName: document.getElementById("sigFormulaName").value,
      stock: document.getElementById("sigStock").value,
      result: document.getElementById("sigResult").value,
      days: +document.getElementById("sigDays").value || null,
      pnlRatio: +document.getElementById("sigPnLRatio").value || null
    });
    e.target.reset();
    await loadFormulas();
    await loadDashboard();
  });

  document.getElementById("mistakeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await db.mistakes.add({
      date: document.getElementById("mistakeDate").value,
      stock: document.getElementById("mistakeStock").value,
      type: document.getElementById("mistakeType").value,
      desc: document.getElementById("mistakeDesc").value,
      rule: document.getElementById("mistakeRule").value,
      fix: document.getElementById("mistakeFix").value
    });
    e.target.reset();
    await loadMistakes();
  });
}

// ---------- 导入导出 ----------
function setupImportExport() {
  document.getElementById("exportBtn").addEventListener("click", exportAllData);
  document.getElementById("importBtn").addEventListener("click", () => {
    document.getElementById("importFileInput").click();
  });
  document.getElementById("importFileInput").addEventListener("change", importData);
}

async function exportAllData() {
  const data = {
    trades: await db.trades.toArray(),
    scores: await db.scores.toArray(),
    formulaSignals: await db.formulaSignals.toArray(),
    mistakes: await db.mistakes.toArray(),
    formulas: await db.formulas.toArray()
  };
  const blob = new Blob([JSON.stringify(data)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `quant_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (confirm("导入将清空现有数据并替换，确定继续？")) {
        await db.trades.clear();
        await db.scores.clear();
        await db.formulaSignals.clear();
        await db.mistakes.clear();
        await db.formulas.clear();
        if (data.trades) await db.trades.bulkAdd(data.trades);
        if (data.scores) await db.scores.bulkAdd(data.scores);
        if (data.formulaSignals) await db.formulaSignals.bulkAdd(data.formulaSignals);
        if (data.mistakes) await db.mistakes.bulkAdd(data.mistakes);
        if (data.formulas) await db.formulas.bulkAdd(data.formulas);
        await refreshAll();
        alert("导入成功！");
      }
    } catch (err) {
      alert("文件格式错误");
      console.error(err);
    }
  };
  reader.readAsText(file);
}