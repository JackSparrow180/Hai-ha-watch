(function(){
  "use strict";

  var STORAGE_KEY = "haihaUsdWatch:v1"; // keep key so existing user data survives
  var APP_VERSION = "2.2";
  var STALE_WARNING_MS = 6 * 60 * 60 * 1000;
  var STALE_SEVERE_MS = 24 * 60 * 60 * 1000;
  var AUTO_ENDPOINT = "./api/haiha-rate";
  var AUTO_REFRESH_MS = 5 * 60 * 1000; // refresh while app is open
  var HHMT_SELL_URL = "https://www.hhmt.com.au/foreign-exchange?type=you-sell";
  var MAX_HISTORY_ENTRIES = 3000;

  function defaultState(){
    return {
      history: [],
      usdHeld: null,
      target: { rate: null, enabled: false },
      notifiedFor: null,
      auto: { enabled: true, lastCheckedAt: null, lastSuccessAt: null, lastError: null }
    };
  }

  function isValidRate(rate){
    return typeof rate === "number" && isFinite(rate) && rate > 0.5 && rate < 3;
  }

  function normalizeEntry(entry){
    if(!entry || !isValidRate(Number(entry.rate))) return null;
    var ts = Number(entry.ts);
    if(!isFinite(ts)) ts = Date.now();

    var fullyVerifiedLive = entry.verified === true &&
      entry.provider === "HAI_HA" &&
      entry.fromCurrency === "USD" &&
      entry.toCurrency === "AUD" &&
      entry.customerAction === "SELL" &&
      entry.mode === "LIVE";

    var wasLegacyAuto = entry.sourceKind === "haiha-auto" && !fullyVerifiedLive;

    return {
      id: entry.id || uid(),
      rate: Number(entry.rate),
      ts: ts,
      source: entry.source || (wasLegacyAuto ? "Hai Ha Auto (cũ, chưa xác minh)" : "Nhập thủ công"),
      sourceKind: fullyVerifiedLive ? "haiha-auto" : (wasLegacyAuto ? "legacy-auto" : (entry.sourceKind || "manual")),
      provider: "HAI_HA",
      mode: fullyVerifiedLive ? "LIVE" : (wasLegacyAuto ? "LEGACY_AUTO" : "MANUAL"),
      fromCurrency: "USD",
      toCurrency: "AUD",
      customerAction: "SELL",
      verified: fullyVerifiedLive
    };
  }

  function loadState(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var merged = Object.assign(defaultState(), parsed || {});
      merged.target = Object.assign({ rate:null, enabled:false }, parsed && parsed.target ? parsed.target : {});
      merged.auto = Object.assign({ enabled:true, lastCheckedAt:null, lastSuccessAt:null, lastError:null }, parsed && parsed.auto ? parsed.auto : {});
      merged.history = Array.isArray(parsed && parsed.history)
        ? parsed.history.map(normalizeEntry).filter(Boolean).slice(-MAX_HISTORY_ENTRIES)
        : [];
      return merged;
    }catch(e){
      console.warn("Không đọc được dữ liệu đã lưu:", e);
      return defaultState();
    }
  }

  function saveState(){
    try{
      if(state.history.length > MAX_HISTORY_ENTRIES){
        state.history = sortedHistory().slice(-MAX_HISTORY_ENTRIES);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }catch(e){
      console.warn("Không lưu được dữ liệu:", e);
    }
  }

  var state = loadState();
  saveState(); // persist migrated metadata without changing the storage key

  function fmtRate(n){
    if(n === null || n === undefined || isNaN(n)) return "—";
    return Number(n).toLocaleString("vi-VN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }

  function fmtAud(n){
    if(n === null || n === undefined || isNaN(n)) return "0 AUD";
    return Number(n).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " AUD";
  }

  function fmtDateTime(ts){
    var d = new Date(ts);
    return d.toLocaleString("vi-VN", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
  }

  function fmtDate(ts){
    return new Date(ts).toLocaleDateString("vi-VN", { day:"2-digit", month:"2-digit", year:"numeric" });
  }

  function fmtAge(ts){
    var ageMs = Math.max(0, Date.now() - ts);
    var mins = Math.floor(ageMs / 60000);
    if(mins < 1) return "vừa xong";
    if(mins < 60) return mins + " phút";
    var hours = Math.floor(mins / 60);
    if(hours < 24) return hours + " giờ";
    return Math.floor(hours / 24) + " ngày";
  }

  function sortedHistory(){
    return state.history.slice().sort(function(a,b){ return a.ts - b.ts; });
  }

  function latestEntry(){
    var h = sortedHistory();
    return h.length ? h[h.length - 1] : null;
  }

  function previousEntry(){
    var h = sortedHistory();
    return h.length > 1 ? h[h.length - 2] : null;
  }

  function uid(){
    return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  }

  function liveFreshnessTs(entry){
    if(entry && entry.mode === "LIVE" && entry.verified === true && state.auto && state.auto.lastSuccessAt){
      return Number(state.auto.lastSuccessAt) || entry.ts;
    }
    return entry ? entry.ts : null;
  }

  function staleLevel(entry){
    if(!entry) return "none";
    var age = Date.now() - liveFreshnessTs(entry);
    if(age > STALE_SEVERE_MS) return "severe";
    if(age > STALE_WARNING_MS) return "warning";
    return "fresh";
  }

  var els = {
    rateValue: document.getElementById("rateValue"),
    rateSub: document.getElementById("rateSub"),
    changeBadge: document.getElementById("changeBadge"),
    staleBadge: document.getElementById("staleBadge"),
    usdHeld: document.getElementById("usdHeld"),
    audEstimate: document.getElementById("audEstimate"),
    audDifference: document.getElementById("audDifference"),
    targetRate: document.getElementById("targetRate"),
    targetToggle: document.getElementById("targetToggle"),
    targetStatus: document.getElementById("targetStatus"),
    targetBreakdown: document.getElementById("targetBreakdown"),
    highVal: document.getElementById("highVal"),
    highDate: document.getElementById("highDate"),
    lowVal: document.getElementById("lowVal"),
    lowDate: document.getElementById("lowDate"),
    historyList: document.getElementById("historyList"),
    chartEmpty: document.getElementById("chartEmpty"),
    rateChartCanvas: document.getElementById("rateChart"),
    sourceDot: document.getElementById("sourceDot"),
    sourceTitle: document.getElementById("sourceTitle"),
    sourceMeta: document.getElementById("sourceMeta"),
    autoSpinner: document.getElementById("autoSpinner"),
    toggleAutoBtn: document.getElementById("toggleAutoBtn"),
    autoCheckBtn: document.getElementById("autoCheckBtn")
  };

  function renderSourceStatus(){
    var latest = latestEntry();
    var auto = state.auto || {};
    els.toggleAutoBtn.textContent = "Tự cập nhật: " + (auto.enabled ? "BẬT" : "TẮT");

    if(latest && latest.mode === "LIVE" && latest.verified === true){
      var level = staleLevel(latest);
      if(level === "fresh"){
        els.sourceDot.className = "source-dot live";
        els.sourceTitle.textContent = "Hai Ha Auto · LIVE · 5 phút/lần";
      }else if(level === "warning"){
        els.sourceDot.className = "source-dot manual";
        els.sourceTitle.textContent = "Hai Ha Auto · STALE";
      }else{
        els.sourceDot.className = "source-dot error";
        els.sourceTitle.textContent = "Hai Ha Auto · dữ liệu quá cũ";
      }
      els.sourceMeta.textContent = "Lần xác minh Hai Ha gần nhất: " + fmtDateTime(auto.lastSuccessAt || latest.ts) +
        ". App đọc trực tiếp YOU SELL USD → YOU RECEIVE AUD và tính tỷ giá từ số AUD nhận được / số USD bán." +
        (auto.lastError ? " Auto Check gần nhất lỗi: " + auto.lastError : "");
      return;
    }

    if(latest && latest.mode === "LEGACY_AUTO"){
      els.sourceDot.className = "source-dot manual";
      els.sourceTitle.textContent = "Dữ liệu Auto cũ · chưa xác minh đầy đủ";
      els.sourceMeta.textContent = "Entry này được giữ lại để không mất lịch sử, nhưng Phase B không coi nó là LIVE. Hãy Auto Check lại hoặc nhập thủ công.";
      return;
    }

    if(latest){
      els.sourceDot.className = "source-dot manual";
      els.sourceTitle.textContent = "Đang dùng tỷ giá nhập thủ công";
      els.sourceMeta.textContent = auto.lastError
        ? "Auto Check gần nhất chưa thành công: " + auto.lastError
        : "Dữ liệu hiện tại do bạn nhập. App chỉ chuyển sang LIVE khi backend xác minh đủ SELL + USD → AUD.";
      return;
    }

    if(auto.lastError){
      els.sourceDot.className = "source-dot error";
      els.sourceTitle.textContent = "Chưa lấy được tỷ giá Hai Ha";
      els.sourceMeta.textContent = auto.lastError + " Bạn có thể dùng nút Nhập thủ công.";
    }else{
      els.sourceDot.className = "source-dot";
      els.sourceTitle.textContent = "Chưa có dữ liệu";
      els.sourceMeta.textContent = "Bấm Kiểm tra tự động. Nếu backend không xác minh được Bạn bán USD → nhận AUD, app sẽ không lưu tỷ giá.";
    }
  }

  function renderTicker(){
    var latest = latestEntry();
    var prev = previousEntry();
    if(!latest){
      els.rateValue.textContent = "—";
      els.rateSub.textContent = "Chưa có tỷ giá nào được ghi lại";
      els.changeBadge.textContent = "Chưa có dữ liệu so sánh";
      els.changeBadge.className = "badge flat";
      els.staleBadge.hidden = true;
      return;
    }

    els.rateValue.textContent = fmtRate(latest.rate);
    if(latest.mode === "LIVE" && latest.verified === true){
      els.rateSub.textContent = "Hai Ha xác minh lúc " + fmtDateTime((state.auto && state.auto.lastSuccessAt) || latest.ts) + " · " + latest.source;
    }else{
      els.rateSub.textContent = "Cập nhật lúc " + fmtDateTime(latest.ts) + " · " + latest.source;
    }

    var level = staleLevel(latest);
    els.staleBadge.hidden = level === "fresh";
    if(level === "warning"){
      els.staleBadge.className = "badge stale";
      els.staleBadge.textContent = "⚠ Tỷ giá này được xác minh cách đây " + fmtAge(liveFreshnessTs(latest));
    }else if(level === "severe"){
      els.staleBadge.className = "badge down";
      els.staleBadge.textContent = "⚠ Tỷ giá có thể đã cũ · " + fmtAge(liveFreshnessTs(latest)) + " · hãy kiểm tra Hai Ha";
    }

    if(prev){
      var diff = latest.rate - prev.rate;
      var pct = prev.rate ? (diff / prev.rate) * 100 : 0;
      var sign = diff > 0 ? "+" : "";
      els.changeBadge.textContent = Math.abs(diff) < 1e-9
        ? "Không đổi so với lần trước"
        : sign + pct.toFixed(2) + "% so với lần trước (" + sign + diff.toFixed(4) + ")";
      els.changeBadge.className = "badge " + (diff > 1e-9 ? "up" : (diff < -1e-9 ? "down" : "flat"));
    }else{
      els.changeBadge.textContent = "Ghi thêm tỷ giá để so sánh biến động";
      els.changeBadge.className = "badge flat";
    }
  }

  function renderCalculator(){
    var latest = latestEntry();
    var prev = previousEntry();
    var usd = parseFloat(els.usdHeld.value);
    els.audDifference.className = "money-diff";

    if(isNaN(usd) || usd < 0 || !latest){
      els.audEstimate.textContent = "0 AUD";
      els.audDifference.textContent = !latest
        ? "Chưa có tỷ giá để tính chênh lệch."
        : "Nhập số USD bạn đang giữ để xem chênh lệch.";
      return;
    }

    els.audEstimate.textContent = fmtAud(usd * latest.rate);
    if(!prev){
      els.audDifference.textContent = "Ghi thêm ít nhất 1 tỷ giá nữa để xem số AUD tăng/giảm.";
      return;
    }

    var diffAud = usd * (latest.rate - prev.rate);
    if(Math.abs(diffAud) < 0.005){
      els.audDifference.textContent = "So với lần cập nhật trước: số AUD ước tính không đổi.";
    }else if(diffAud > 0){
      els.audDifference.classList.add("positive");
      els.audDifference.textContent = "↑ Nếu đổi theo tỷ giá mới, bạn nhận thêm khoảng " + fmtAud(diffAud) + " so với lần trước.";
    }else{
      els.audDifference.classList.add("negative");
      els.audDifference.textContent = "↓ Nếu đổi theo tỷ giá mới, bạn nhận ít hơn khoảng " + fmtAud(Math.abs(diffAud)) + " so với lần trước.";
    }
  }

  function renderTargetStatus(){
    var latest = latestEntry();
    var target = state.target.rate;
    var usd = parseFloat(els.usdHeld.value);
    els.targetBreakdown.hidden = true;
    els.targetBreakdown.innerHTML = "";

    if(target && latest && !isNaN(usd) && usd >= 0){
      var currentAud = usd * latest.rate;
      var targetAud = usd * target;
      var targetDiff = targetAud - currentAud;
      var diffText = (targetDiff >= 0 ? "+" : "-") + fmtAud(Math.abs(targetDiff));
      els.targetBreakdown.hidden = false;
      els.targetBreakdown.innerHTML =
        "Theo tỷ giá hiện tại: <strong>" + fmtAud(currentAud) + "</strong><br>" +
        "Nếu đạt " + fmtRate(target) + ": <strong>" + fmtAud(targetAud) + "</strong><br>" +
        "Chênh lệch: <strong>" + diffText + "</strong>";
    }

    if(!state.target.enabled || !target){
      els.targetStatus.className = "status-line watching";
      els.targetStatus.textContent = "Nhập tỷ giá mục tiêu và bật thông báo để bắt đầu theo dõi.";
      return;
    }
    if(!latest){
      els.targetStatus.className = "status-line watching";
      els.targetStatus.textContent = "Đang theo dõi khi app mở — chưa có tỷ giá hiện tại.";
      return;
    }
    if(latest.rate >= target){
      els.targetStatus.className = "status-line reached";
      els.targetStatus.textContent = "🎯 Đã đạt mục tiêu " + fmtRate(target) + "! Tỷ giá hiện tại là " + fmtRate(latest.rate) + ". Hãy xác nhận trực tiếp với Hai Ha trước khi giao dịch.";
    }else{
      els.targetStatus.className = "status-line watching";
      els.targetStatus.textContent = "Đang theo dõi khi app mở — sẽ báo khi tỷ giá đạt " + fmtRate(target) + " (hiện tại: " + fmtRate(latest.rate) + ").";
    }

    if(window.Notification && Notification.permission === "denied"){
      els.targetStatus.className = "status-line blocked";
      els.targetStatus.textContent = "Trình duyệt đang chặn thông báo. Hãy bật quyền thông báo cho trang này trong cài đặt trình duyệt.";
    }
  }

  function renderStats(){
    var h = state.history;
    if(!h.length){
      els.highVal.textContent = "—";
      els.highDate.textContent = "Chưa có dữ liệu";
      els.lowVal.textContent = "—";
      els.lowDate.textContent = "Chưa có dữ liệu";
      return;
    }
    var high = h.reduce(function(a,b){ return b.rate > a.rate ? b : a; });
    var low = h.reduce(function(a,b){ return b.rate < a.rate ? b : a; });
    els.highVal.textContent = fmtRate(high.rate);
    els.highDate.textContent = fmtDate(high.ts);
    els.lowVal.textContent = fmtRate(low.rate);
    els.lowDate.textContent = fmtDate(low.ts);
  }

  function renderHistoryList(){
    var h = sortedHistory().slice().reverse();
    if(!h.length){
      els.historyList.innerHTML = '<p class="empty-note">Chưa có tỷ giá nào được ghi lại. Nhấn "Nhập thủ công" hoặc "Kiểm tra tự động" để bắt đầu.</p>';
      return;
    }
    els.historyList.innerHTML = "";
    h.slice(0, 100).forEach(function(entry){
      var row = document.createElement("div");
      row.className = "history-item";
      var typeLabel = entry.mode === "LIVE" && entry.verified ? "LIVE ✓" : (entry.mode === "LEGACY_AUTO" ? "AUTO CŨ · chưa xác minh" : "MANUAL");
      row.innerHTML =
        '<div><div class="rate">' + fmtRate(entry.rate) + ' AUD</div>' +
        '<div class="meta">' + fmtDateTime(entry.ts) + " · " + entry.source + " · " + typeLabel + '</div></div>' +
        '<button class="del" aria-label="Xóa mục này" data-id="' + entry.id + '">×</button>';
      els.historyList.appendChild(row);
    });
    els.historyList.querySelectorAll(".del").forEach(function(btn){
      btn.addEventListener("click", function(){
        state.history = state.history.filter(function(e){ return e.id !== btn.getAttribute("data-id"); });
        saveState();
        renderAll();
      });
    });
  }

  var chart = null;
  var currentRange = 7;

  function renderChart(){
    var now = Date.now();
    var windowMs = currentRange * 24 * 60 * 60 * 1000;
    var points = sortedHistory().filter(function(e){ return (now - e.ts) <= windowMs; });

    if(typeof window.Chart === "undefined"){
      els.chartEmpty.hidden = false;
      els.chartEmpty.innerHTML = "Không tải được thư viện biểu đồ.<br>App vẫn tính tỷ giá bình thường; hãy mở lại khi có mạng để tải Chart.js.";
      els.rateChartCanvas.style.display = "none";
      return;
    }

    if(points.length < 2){
      els.chartEmpty.hidden = false;
      els.chartEmpty.innerHTML = "Chưa đủ dữ liệu cho khoảng thời gian này.<br>Hãy cập nhật tỷ giá thường xuyên hơn để thấy biểu đồ.";
      els.rateChartCanvas.style.display = "none";
      if(chart){ chart.destroy(); chart = null; }
      return;
    }

    els.chartEmpty.hidden = true;
    els.rateChartCanvas.style.display = "block";
    var labels = points.map(function(e){ return fmtDate(e.ts); });
    var data = points.map(function(e){ return e.rate; });

    if(chart){ chart.destroy(); }
    var ctx = els.rateChartCanvas.getContext("2d");
    var gradient = ctx.createLinearGradient(0,0,0,220);
    gradient.addColorStop(0, "rgba(201,150,43,0.35)");
    gradient.addColorStop(1, "rgba(201,150,43,0.02)");

    chart = new window.Chart(ctx, {
      type: "line",
      data: { labels: labels, datasets: [{
        data: data,
        borderColor: "#16241D",
        backgroundColor: gradient,
        pointBackgroundColor: "#C9962B",
        pointBorderColor: "#16241D",
        pointRadius: points.length > 40 ? 0 : 3,
        borderWidth: 2,
        tension: 0.25,
        fill: true
      }]},
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display:false }, ticks: { color:"#5B6B5F", font:{ family:"IBM Plex Mono", size:10 }, maxRotation:0, autoSkip:true, maxTicksLimit:6 } },
          y: { grid: { color:"rgba(22,36,29,0.08)" }, ticks: { color:"#5B6B5F", font:{ family:"IBM Plex Mono", size:10 } } }
        }
      }
    });
    els.rateChartCanvas.parentElement.style.height = "220px";
  }

  document.querySelectorAll(".tab").forEach(function(tab){
    tab.addEventListener("click", function(){
      document.querySelectorAll(".tab").forEach(function(t){
        t.classList.remove("active");
        t.setAttribute("aria-selected","false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected","true");
      currentRange = parseInt(tab.getAttribute("data-range"), 10);
      renderChart();
    });
  });

  var autoInFlight = false;

  function addRateEntry(rate, meta){
    rate = Number(rate);
    if(!isValidRate(rate)) throw new Error("Tỷ giá trả về không hợp lệ.");
    meta = meta || {};
    var when = meta.ts ? new Date(meta.ts).getTime() : Date.now();
    if(!isFinite(when)) when = Date.now();

    var mode = meta.mode === "LIVE" ? "LIVE" : "MANUAL";
    var verified = mode === "LIVE" && meta.verified === true;
    if(mode === "LIVE" && !verified){
      throw new Error("Tỷ giá tự động chưa được xác minh đầy đủ.");
    }

    var entry = {
      id: uid(),
      rate: rate,
      ts: when,
      source: meta.source || (verified ? "Hai Ha Auto" : "Nhập thủ công"),
      sourceKind: verified ? "haiha-auto" : "manual",
      provider: "HAI_HA",
      mode: mode,
      fromCurrency: "USD",
      toCurrency: "AUD",
      customerAction: "SELL",
      verified: verified
    };

    var latest = latestEntry();
    var dedupeWindow = verified ? 90 * 60 * 1000 : 10 * 60 * 1000;
    if(latest &&
       latest.provider === entry.provider &&
       latest.mode === entry.mode &&
       latest.verified === entry.verified &&
       Math.abs(latest.rate - entry.rate) < 1e-9 &&
       Math.abs(when - latest.ts) < dedupeWindow){
      return { entry: latest, added: false };
    }

    state.history.push(entry);
    if(state.history.length > MAX_HISTORY_ENTRIES){
      state.history = sortedHistory().slice(-MAX_HISTORY_ENTRIES);
    }
    return { entry: entry, added: true };
  }

  function payloadIsVerifiedHaiHaSell(payload){
    return payload &&
      payload.ok === true &&
      payload.provider === "HAI_HA" &&
      payload.fromCurrency === "USD" &&
      payload.toCurrency === "AUD" &&
      payload.customerAction === "SELL" &&
      payload.mode === "CUSTOMER_SELLS_USD" &&
      payload.verified === true &&
      (payload.quoteMethod === "SELL_OUTPUT_DIVIDED_BY_INPUT" ||
       payload.quoteMethod === "HAIHA_SELL_USD_RATE_RECIPROCAL") &&
      isValidRate(Number(payload.rate));
  }

  async function fetchAutomaticRate(userInitiated){
    if(autoInFlight) return;
    autoInFlight = true;
    els.autoSpinner.hidden = false;
    els.autoCheckBtn.disabled = true;
    state.auto.lastCheckedAt = Date.now();
    state.auto.lastError = null;
    saveState();
    renderSourceStatus();

    try{
      var response = await fetch(AUTO_ENDPOINT + "?t=" + Date.now(), {
        cache:"no-store",
        headers:{ "Accept":"application/json" }
      });
      var payload = null;
      try{ payload = await response.json(); }catch(_e){}

      if(!response.ok){
        var statusText = payload && payload.status ? " [" + payload.status + "]" : "";
        throw new Error((payload && payload.message ? payload.message : "Auto Check lỗi HTTP " + response.status) + statusText);
      }
      if(!payloadIsVerifiedHaiHaSell(payload)){
        throw new Error("Backend chưa xác minh đầy đủ SELL + USD → AUD; tỷ giá bị từ chối.");
      }

      addRateEntry(Number(payload.rate), {
        source: payload.source || "Hai Ha Auto",
        ts: payload.fetchedAt || Date.now(),
        mode: "LIVE",
        verified: true
      });
      state.auto.lastSuccessAt = new Date(payload.fetchedAt || Date.now()).getTime();
      state.auto.lastError = null;
      saveState();
      renderAll();
    }catch(e){
      state.auto.lastError = e && e.message ? e.message : "Không thể kết nối nguồn Hai Ha.";
      saveState();
      renderSourceStatus();
      if(userInitiated){
        els.sourceMeta.textContent = state.auto.lastError + " App không thay bằng tỷ giá thị trường. Bạn có thể nhập thủ công.";
      }
    }finally{
      autoInFlight = false;
      els.autoSpinner.hidden = true;
      els.autoCheckBtn.disabled = false;
    }
  }

  function maybeNotify(){
    if(!state.target.enabled || !state.target.rate) return;
    var latest = latestEntry();
    if(!latest || latest.rate < state.target.rate) return;
    if(state.notifiedFor === latest.id) return;

    state.notifiedFor = latest.id;
    saveState();

    if(window.Notification && Notification.permission === "granted"){
      try{
        new Notification("Hai Ha USD Watch — Đạt tỷ giá mục tiêu!", {
          body: "Tỷ giá hiện tại " + fmtRate(latest.rate) + " AUD đã đạt mục tiêu " + fmtRate(state.target.rate) + ".",
          icon: "./icon-192.png"
        });
      }catch(e){
        console.warn("Không thể hiển thị notification:", e);
      }
    }
  }

  function renderAll(){
    renderSourceStatus();
    renderTicker();
    renderCalculator();
    renderTargetStatus();
    renderStats();
    renderHistoryList();
    renderChart();
    maybeNotify();
  }

  els.usdHeld.value = state.usdHeld !== null ? state.usdHeld : "";
  els.usdHeld.addEventListener("input", function(){
    var v = parseFloat(els.usdHeld.value);
    state.usdHeld = isNaN(v) ? null : v;
    saveState();
    renderCalculator();
    renderTargetStatus();
  });

  els.targetRate.value = state.target.rate !== null ? state.target.rate : "";
  els.targetToggle.checked = !!state.target.enabled;
  els.targetRate.addEventListener("input", function(){
    var v = parseFloat(els.targetRate.value);
    state.target.rate = isNaN(v) ? null : v;
    state.notifiedFor = null;
    saveState();
    renderTargetStatus();
  });

  els.targetToggle.addEventListener("change", function(){
    state.target.enabled = els.targetToggle.checked;
    saveState();
    if(state.target.enabled && window.Notification && Notification.permission === "default"){
      Notification.requestPermission().then(function(){ renderTargetStatus(); });
    }
    renderTargetStatus();
    maybeNotify();
  });

  els.autoCheckBtn.addEventListener("click", function(){ fetchAutomaticRate(true); });
  els.toggleAutoBtn.addEventListener("click", function(){
    state.auto.enabled = !state.auto.enabled;
    saveState();
    renderSourceStatus();
    if(state.auto.enabled) fetchAutomaticRate(true);
  });

  var dialog = document.getElementById("rateDialog");
  document.getElementById("openDialogBtn").addEventListener("click", function(){
    document.getElementById("rateInput").value = "";
    dialog.showModal();
    document.getElementById("rateInput").focus();
  });
  document.getElementById("cancelDialogBtn").addEventListener("click", function(){ dialog.close(); });
  document.getElementById("openHhmtBtn").addEventListener("click", function(){ window.open(HHMT_SELL_URL, "_blank", "noopener"); });

  document.getElementById("saveRateBtn").addEventListener("click", function(){
    var val = parseFloat(document.getElementById("rateInput").value);
    if(!isValidRate(val)){
      document.getElementById("rateInput").focus();
      return;
    }
    var source = document.getElementById("sourceInput").value;
    addRateEntry(val, { source: source, ts: Date.now(), mode: "MANUAL", verified: false });
    saveState();
    dialog.close();
    renderAll();
  });

  var deferredPrompt = null;
  var installBtn = document.getElementById("installBtn");
  window.addEventListener("beforeinstallprompt", function(e){
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener("click", function(){
    if(!deferredPrompt) return;
    var promptEvent = deferredPrompt;
    promptEvent.prompt();
    Promise.resolve(promptEvent.userChoice)
      .catch(function(e){ console.warn("Install prompt error:", e); })
      .finally(function(){
        deferredPrompt = null;
        installBtn.hidden = true;
      });
  });
  window.addEventListener("appinstalled", function(){ installBtn.hidden = true; });

  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("./sw.js").catch(function(e){ console.warn("SW register failed:", e); });
    });
  }

  renderAll();

  function maybeAutoRefresh(){
    if(!state.auto.enabled || document.visibilityState === "hidden") return;
    var last = state.auto.lastCheckedAt || 0;
    if(Date.now() - last >= AUTO_REFRESH_MS) fetchAutomaticRate(false);
  }

  setTimeout(maybeAutoRefresh, 1200);
  setInterval(maybeAutoRefresh, 30 * 1000);
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState === "visible") maybeAutoRefresh();
  });

  console.info("Hai Ha USD Watch v" + APP_VERSION + " loaded");
})();
