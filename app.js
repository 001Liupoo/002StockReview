// ======================== 数据层 ========================
class DataManager {
  constructor() {
    this.db = new Dexie("QuantReviewDB");
    this.db.version(1).stores({
      trades: "++id, date, code, name, direction, side, price, volume, amount, fee, formulaName, note, currentPrice",
      scores: "++id, date, code, name, daPan, banKuai, jiShu, liangJia, qingXu, score, plan",
      formulaSignals: "++id, date, formulaName, stock, result, days, pnlRatio",
      mistakes: "++id, date, stock, type, desc, rule, fix",
      formulas: "++id, name"
    });
  }

  // ---------- 通用 ----------
  async getAll(table) {
    return await this.db[table].toArray();
  }

  async add(table, data) {
    return await this.db[table].add(data);
  }

  async delete(table, id) {
    return await this.db[table].delete(id);
  }

  async update(table, id, data) {
    return await this.db[table].update(id, data);
  }

  async clear(table) {
    return await this.db[table].clear();
  }

  async bulkAdd(table, items) {
    return await this.db[table].bulkAdd(items);
  }

  // ---------- 初始化公式 ----------
  async initFormulas(defaultList) {
    const count = await this.db.formulas.count();
    if (count === 0) {
      await this.db.formulas.bulkAdd(defaultList.map(name => ({ name })));
    }
    return await this.db.formulas.toArray();
  }

  // ---------- 仪表盘数据 ----------
  async getDashboardData() {
    const trades = await this.db.trades.toArray();
    const signals = await this.db.formulaSignals.toArray();
    // 计算已实现盈亏（简单）
    let buyAmt = 0, sellAmt = 0;
    const holdings = {}; // code -> { name, volume, totalCost }
    trades.forEach(t => {
      const amt = t.price * t.volume;
      if (t.side === "买入") {
        buyAmt += amt + (t.fee || 0);
        if (!holdings[t.code]) holdings[t.code] = { name: t.name, volume: 0, totalCost: 0 };
        holdings[t.code].volume += t.volume;
        holdings[t.code].totalCost += amt + (t.fee || 0);
      } else {
        sellAmt += amt - (t.fee || 0);
        if (holdings[t.code]) {
          holdings[t.code].volume -= t.volume;
          // 简单平均成本扣减（先进先出简化）
          // 这里只用于展示持仓数量，不计入收益
        }
      }
    });
    const realizedPnL = sellAmt - buyAmt;

    // 当前持仓（数量>0）
    const holdingList = Object.keys(holdings)
      .filter(code => holdings[code].volume > 0)
      .map(code => ({
        code,
        name: holdings[code].name,
        volume: holdings[code].volume,
        avgCost: holdings[code].totalCost / holdings[code].volume
      }));

    // 胜率（基于公式信号）
    const totalSignals = signals.length;
    const successSignals = signals.filter(s => s.result === "成功").length;
    const winRate = totalSignals > 0 ? (successSignals / totalSignals) * 100 : 0;

    return { realizedPnL, holdingList, winRate, signals, trades };
  }

  // 获取资金曲线数据（最近30天）
  async getEquityCurve(days = 30) {
    const trades = await this.db.trades.toArray();
    if (trades.length === 0) return { dates: [], values: [] };

    // 按日期排序
    trades.sort((a, b) => a.date.localeCompare(b.date));
    const dailyPnL = {};
    let running = 0;
    trades.forEach(t => {
      const amt = t.price * t.volume;
      const net = t.side === "买入" ? -(amt + (t.fee || 0)) : (amt - (t.fee || 0));
      running += net;
      dailyPnL[t.date] = running;
    });

    // 生成最近days天的连续日期
    const dates = [];
    const values = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dates.push(key);
      values.push(dailyPnL[key] || (values.length ? values[values.length - 1] : 0));
    }
    return { dates, values };
  }

  // 获取下拉选项（公式）
  async getFormulaOptions() {
    return await this.db.formulas.toArray();
  }
}

// ======================== UI 渲染层 ========================
class UIManager {
  constructor(dataManager) {
    this.data = dataManager;
    this.currentTab = "dashboard";
    this.pnlChartInstance = null;
    this.toastTimer = null;
  }

  // ---------- 导航 ----------
  setupNavigation() {
    document.querySelectorAll(".bottom-nav button").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const tab = e.currentTarget.dataset.tab;
        this.switchTab(tab);
      });
    });
  }

  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
    document.getElementById(tab).classList.add("active");
    document.querySelectorAll(".bottom-nav button").forEach(b => b.classList.remove("active"));
    document.querySelector(`.bottom-nav button[data-tab="${tab}"]`).classList.add("active");
    this.refreshTab(tab);
  }

  async refreshTab(tab) {
    try {
      switch (tab) {
        case "dashboard": await this.loadDashboard(); break;
        case "trades": await this.loadTrades(); break;
        case "scores": await this.loadScores(); break;
        case "formulas": await this.loadFormulas(); break;
        case "mistakes": await this.loadMistakes(); break;
      }
    } catch (err) {
      this.showToast("刷新失败: " + err.message, "error");
    }
  }

  // ---------- Toast 消息 ----------
  showToast(msg, type = "info") {
    const old = document.querySelector(".toast");
    if (old) old.remove();
    const div = document.createElement("div");
    div.className = `toast ${type}`;
    div.textContent = msg;
    document.body.appendChild(div);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => div.remove(), 3000);
  }

  // ---------- 仪表盘 ----------
  async loadDashboard() {
    const data = await this.data.getDashboardData();
    document.getElementById("totalPnL").textContent = data.realizedPnL.toFixed(2);
    document.getElementById("winRate").textContent = data.winRate.toFixed(1) + "%";
    document.getElementById("holdingCount").textContent = data.holdingList.length;

    // 绘制曲线
    const curve = await this.data.getEquityCurve(30);
    this.drawPnlChart(curve.dates, curve.values);
  }

  drawPnlChart(labels, values) {
    const ctx = document.getElementById("pnlChart").getContext("2d");
    if (this.pnlChartInstance) this.pnlChartInstance.destroy();

    this.pnlChartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "累计收益",
          data: values,
          borderColor: "#16213e",
          backgroundColor: "rgba(22,33,62,0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 30, font: { size: 10 } } }
        }
      }
    });
  }

  // ---------- 交易流水 ----------
  async loadTrades() {
    const trades = await this.data.getAll("trades");
    trades.reverse(); // 最新在前
    const container = document.getElementById("tradeList");
    container.innerHTML = trades.map(t => `
      <div class="list-item" data-id="${t.id}" data-type="trade">
        <button class="delete-btn" data-id="${t.id}" data-table="trades">✕</button>
        <div><strong>${t.date} ${t.name}(${t.code})</strong> ${t.direction} ${t.side}</div>
        <div>价格: ${t.price.toFixed(2)} 数量: ${t.volume} 金额: ${(t.price*t.volume).toFixed(2)} 手续费: ${(t.fee||0).toFixed(2)}</div>
        <div>公式: ${t.formulaName || "无"} 备注: ${t.note || ""}</div>
        ${t.currentPrice ? `<div>现价: ${t.currentPrice.toFixed(2)} 浮动盈亏: ${((t.currentPrice - t.price) * t.volume).toFixed(2)}</div>` : ''}
      </div>
    `).join("");

    // 删除按钮事件（委托）
    container.querySelectorAll(".delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = +btn.dataset.id;
        const table = btn.dataset.table;
        if (confirm("确认删除？")) {
          await this.data.delete(table, id);
          await this.loadTrades();
          await this.loadDashboard();
          this.showToast("删除成功");
        }
      });
    });

    // 双击编辑（简化：弹出prompt修改备注）
    container.querySelectorAll(".list-item").forEach(item => {
      item.addEventListener("dblclick", async () => {
        const id = +item.dataset.id;
        const trade = await this.data.db.trades.get(id);
        if (!trade) return;
        const newNote = prompt("修改备注：", trade.note || "");
        if (newNote !== null) {
          await this.data.update("trades", id, { note: newNote });
          await this.loadTrades();
          this.showToast("备注已更新");
        }
      });
    });

    // 填充下拉公式
    await this.populateFormulaSelect("tradeFormula");
  }

  // ---------- 多维评分 ----------
  async loadScores() {
    const scores = await this.data.getAll("scores");
    scores.reverse();
    const container = document.getElementById("scoreList");
    container.innerHTML = scores.map(s => `
      <div class="list-item" data-id="${s.id}" data-type="score">
        <button class="delete-btn" data-id="${s.id}" data-table="scores">✕</button>
        <div><strong>${s.date} ${s.name}(${s.code})</strong></div>
        <div>大盘:${s.daPan} 板块:${s.banKuai} 技术:${s.jiShu} 量价:${s.liangJia} 情绪:${s.qingXu} | 综合:${s.score.toFixed(1)}</div>
        <div>预案: ${s.plan || "无"}</div>
      </div>
    `).join("");

    // 删除委托
    container.querySelectorAll(".delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = +btn.dataset.id;
        const table = btn.dataset.table;
        if (confirm("确认删除？")) {
          await this.data.delete(table, id);
          await this.loadScores();
          this.showToast("删除成功");
        }
      });
    });
  }

  // ---------- 公式统计 ----------
  async loadFormulas() {
    const signals = await this.data.getAll("formulaSignals");
    signals.reverse();
    const container = document.getElementById("formulaList");
    container.innerHTML = signals.map(s => `
      <div class="list-item" data-id="${s.id}" data-type="signal">
        <button class="delete-btn" data-id="${s.id}" data-table="formulaSignals">✕</button>
        <div><strong>${s.date} ${s.formulaName}</strong> ${s.stock} | ${s.result}</div>
        <div>持有天数: ${s.days || "-"} 盈亏比: ${s.pnlRatio || "-"}</div>
      </div>
    `).join("");

    container.querySelectorAll(".delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = +btn.dataset.id;
        const table = btn.dataset.table;
        if (confirm("确认删除？")) {
          await this.data.delete(table, id);
          await this.loadFormulas();
          await this.loadDashboard();
          this.showToast("删除成功");
        }
      });
    });

    // 汇总
    const total = signals.length;
    const success = signals.filter(s => s.result === "成功").length;
    const winRate = total > 0 ? (success/total*100).toFixed(1) : 0;
    const avgPnL = total > 0 ? (signals.reduce((sum,s) => sum + (s.pnlRatio||0), 0) / total).toFixed(2) : 0;
    document.getElementById("formulaSummary").innerHTML = `
      <h3>公式表现</h3>
      <p>总信号: ${total} | 成功: ${success} | 胜率: ${winRate}% | 平均盈亏比: ${avgPnL}</p>
    `;

    await this.populateFormulaSelect("sigFormulaName");
  }

  // ---------- 错误清单 ----------
  async loadMistakes() {
    const mistakes = await this.data.getAll("mistakes");
    mistakes.reverse();
    const container = document.getElementById("mistakeList");
    container.innerHTML = mistakes.map(m => `
      <div class="list-item" data-id="${m.id}" data-type="mistake">
        <button class="delete-btn" data-id="${m.id}" data-table="mistakes">✕</button>
        <div><strong>${m.date} ${m.stock}</strong> [${m.type}]</div>
        <div>${m.desc || ""}</div>
        <div>违反: ${m.rule || ""} | 改进: ${m.fix || ""}</div>
      </div>
    `).join("");

    container.querySelectorAll(".delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = +btn.dataset.id;
        const table = btn.dataset.table;
        if (confirm("确认删除？")) {
          await this.data.delete(table, id);
          await this.loadMistakes();
          this.showToast("删除成功");
        }
      });
    });
  }

  // ---------- 辅助：填充公式下拉 ----------
  async populateFormulaSelect(selectId, selectedValue = "") {
    const select = document.getElementById(selectId);
    if (!select) return;
    const formulas = await this.data.getFormulaOptions();
    select.innerHTML = formulas.map(f =>
      `<option value="${f.name}" ${f.name === selectedValue ? "selected" : ""}>${f.name}</option>`
    ).join("");
  }

  // ---------- 刷新所有 ----------
  async refreshAll() {
    await this.refreshTab(this.currentTab);
  }
}

// ======================== 主程序 ========================
class App {
  constructor() {
    this.data = new DataManager();
    this.ui = new UIManager(this.data);
    this.init();
  }

  async init() {
    try {
      // 初始化公式
      const defaultFormulas = ["倍量突破MA20", "MACD零上金叉", "涨停板回调", "均线多头排列", "量价背离"];
      await this.data.initFormulas(defaultFormulas);

      // 设置导航
      this.ui.setupNavigation();

      // 设置表单提交
      this.setupForms();

      // 设置导入导出
      this.setupImportExport();

      // 刷新所有
      await this.ui.refreshAll();
    } catch (err) {
      console.error("初始化失败:", err);
      this.ui.showToast("应用初始化失败，请刷新页面", "error");
    }
  }

  // ---------- 表单绑定 ----------
  setupForms() {
    // 交易表单
    const tradeForm = document.getElementById("tradeForm");
    tradeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {
        date: form.tradeDate.value,
        code: form.tradeCode.value.trim(),
        name: form.tradeName.value.trim(),
        direction: form.tradeDirection.value,
        side: form.tradeSide.value,
        price: parseFloat(form.tradePrice.value),
        volume: parseInt(form.tradeVolume.value),
        fee: parseFloat(form.tradeFee.value) || 0,
        formulaName: form.tradeFormula.value || "",
        note: form.tradeNote.value.trim(),
        currentPrice: null // 暂不录入，可后续扩展
      };
      if (!data.date || !data.code || !data.price || !data.volume) {
        this.ui.showToast("请填写完整信息", "error");
        return;
      }
      await this.data.add("trades", data);
      form.reset();
      await this.ui.loadTrades();
      await this.ui.loadDashboard();
      this.ui.showToast("交易记录已添加");
    });

    // 评分表单
    const scoreForm = document.getElementById("scoreForm");
    scoreForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const daPan = +document.getElementById("daPan").value;
      const banKuai = +document.getElementById("banKuai").value;
      const jiShu = +document.getElementById("jiShu").value;
      const liangJia = +document.getElementById("liangJia").value;
      const qingXu = +document.getElementById("qingXu").value;
      const score = (daPan + banKuai + jiShu + liangJia + qingXu) / 5;
      await this.data.add("scores", {
        date: document.getElementById("scoreDate").value,
        code: document.getElementById("scoreCode").value.trim(),
        name: document.getElementById("scoreName").value.trim(),
        daPan, banKuai, jiShu, liangJia, qingXu, score,
        plan: document.getElementById("scorePlan").value.trim()
      });
      scoreForm.reset();
      // 重置滑块显示
      document.querySelectorAll(".slider-group input[type=range]").forEach(slider => {
        const span = document.getElementById(slider.id + "Val");
        if (span) span.textContent = slider.value;
      });
      await this.ui.loadScores();
      this.ui.showToast("评分已保存");
    });

    // 公式信号表单
    const signalForm = document.getElementById("formulaSignalForm");
    signalForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this.data.add("formulaSignals", {
        date: document.getElementById("sigDate").value,
        formulaName: document.getElementById("sigFormulaName").value,
        stock: document.getElementById("sigStock").value.trim(),
        result: document.getElementById("sigResult").value,
        days: parseInt(document.getElementById("sigDays").value) || null,
        pnlRatio: parseFloat(document.getElementById("sigPnLRatio").value) || null
      });
      signalForm.reset();
      await this.ui.loadFormulas();
      await this.ui.loadDashboard();
      this.ui.showToast("信号已记录");
    });

    // 错误表单
    const mistakeForm = document.getElementById("mistakeForm");
    mistakeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this.data.add("mistakes", {
        date: document.getElementById("mistakeDate").value,
        stock: document.getElementById("mistakeStock").value.trim(),
        type: document.getElementById("mistakeType").value,
        desc: document.getElementById("mistakeDesc").value.trim(),
        rule: document.getElementById("mistakeRule").value.trim(),
        fix: document.getElementById("mistakeFix").value.trim()
      });
      mistakeForm.reset();
      await this.ui.loadMistakes();
      this.ui.showToast("错误已记录");
    });
  }

  // ---------- 导入导出 ----------
  setupImportExport() {
    document.getElementById("exportBtn").addEventListener("click", this.exportAllData.bind(this));
    document.getElementById("importBtn").addEventListener("click", () => {
      document.getElementById("importFileInput").click();
    });
    document.getElementById("importFileInput").addEventListener("change", this.importData.bind(this));
  }

  async exportAllData() {
    try {
      const data = {
        trades: await this.data.getAll("trades"),
        scores: await this.data.getAll("scores"),
        formulaSignals: await this.data.getAll("formulaSignals"),
        mistakes: await this.data.getAll("mistakes"),
        formulas: await this.data.getAll("formulas")
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quant_backup_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.ui.showToast("导出成功");
    } catch (err) {
      this.ui.showToast("导出失败: " + err.message, "error");
    }
  }

  async importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm("导入将清空现有所有数据，确定继续？")) return;
      // 清空所有表
      await this.data.clear("trades");
      await this.data.clear("scores");
      await this.data.clear("formulaSignals");
      await this.data.clear("mistakes");
      await this.data.clear("formulas");
      // 批量导入
      if (data.trades) await this.data.bulkAdd("trades", data.trades);
      if (data.scores) await this.data.bulkAdd("scores", data.scores);
      if (data.formulaSignals) await this.data.bulkAdd("formulaSignals", data.formulaSignals);
      if (data.mistakes) await this.data.bulkAdd("mistakes", data.mistakes);
      if (data.formulas) await this.data.bulkAdd("formulas", data.formulas);
      await this.ui.refreshAll();
      this.ui.showToast("导入成功！");
    } catch (err) {
      this.ui.showToast("文件格式错误: " + err.message, "error");
    }
    event.target.value = ""; // 重置input
  }
}

// ---------- 启动 ----------
document.addEventListener("DOMContentLoaded", () => {
  window.app = new App();
});

// 为滑块添加实时显示（保持兼容）
document.querySelectorAll(".slider-group input[type=range]").forEach(slider => {
  slider.addEventListener("input", function() {
    const span = document.getElementById(this.id + "Val");
    if (span) span.textContent = this.value;
  });
});
