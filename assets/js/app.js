/* =========================================================================
 * KOWOO 인보이스 QR 라벨 발행 (app.js)
 *  - 엑셀에서 인보이스 정보 + 품목별 파렛트 구성을 읽어 라벨 전개
 *  - QR 내용: 인보이스번호 · 날짜 · 품목 · 수량 · 구분값(일련번호)
 * ========================================================================= */
(function () {
  'use strict';

  var P = window.KWInvoiceParse;
  var $ = function (s) { return document.querySelector(s); };

  /* 상태 */
  var st = { invoiceNo: '', dateText: '', items: [], labels: [] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(m) {
    var t = $('#toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function fmtQty(n) { return (n == null ? 0 : n).toLocaleString('en-US'); }

  /* -------------------------------------------------------------------
   * QR 내용 — 스캔하면 그대로 읽히도록 항목명을 붙인다.
   *   INVOICE: KW260716-RM
   *   DATE: Jul-16-2026
   *   ITEM: 1. COLD DRAWN PIPE(RB C-MDPS)_SIZE : 32.0x2.8
   *   QTY: 1800 PCS
   *   NO: 03/20          ← 라벨마다 달라 QR이 절대 겹치지 않는 구분값
   * ----------------------------------------------------------------- */
  function payload(label, total) {
    var w = String(total).length < 2 ? 2 : String(total).length;
    return [
      'INVOICE: ' + (st.invoiceNo || '-'),
      'DATE: ' + (st.dateText || '-'),
      'ITEM: ' + (label.desc || '-'),
      'QTY: ' + fmtQty(label.qty) + ' PCS',
      'NO: ' + pad(label.seq, w) + '/' + pad(total, w)
    ].join('\n');
  }

  function qrSvg(text) {
    try {
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    } catch (e) {
      return '<div style="width:100%;aspect-ratio:1;border:1px dashed #999"></div>';
    }
  }

  /* ---- 라벨 목록 재계산 ---- */
  function rebuild() {
    st.labels = P.buildLabels(st.items);
    var n = st.labels.length;
    var from = clampInt($('#f_from').value, 1, 9999, 1);
    var to = clampInt($('#f_to').value, 1, 9999, n);
    if (n) {
      if (to > n) { to = n; $('#f_to').value = n; }
      if (from > n) { from = n; $('#f_from').value = n; }
    }
    return { n: n, from: from, to: Math.max(from, to) };
  }
  function clampInt(v, lo, hi, dflt) {
    var x = parseInt(v, 10);
    if (isNaN(x)) return dflt;
    return Math.max(lo, Math.min(hi, x));
  }

  /* ---- 품목 목록 렌더 ---- */
  function renderItems() {
    var box = $('#itemList');
    if (!st.items.length) {
      box.innerHTML = '<div class="note">파일을 올리면 품목이 표시됩니다.</div>';
      $('#totalBar').hidden = true;
      return;
    }
    box.innerHTML = '';
    st.items.forEach(function (it, i) {
      var gs = it.groups.map(function (g) { return fmtQty(g.unit) + ' × ' + g.count; }).join('  +  ');
      var cnt = it.groups.reduce(function (a, g) { return a + g.count; }, 0);
      var row = document.createElement('div');
      row.className = 'item' + (it.enabled === false ? ' off' : '');
      row.innerHTML =
        '<input type="checkbox" ' + (it.enabled === false ? '' : 'checked') + '>' +
        '<div class="info">' +
          '<div class="nm">' + esc(it.desc) + '</div>' +
          '<div class="sub">' + gs + '  =  ' + fmtQty(it.qty) + ' PCS</div>' +
        '</div>' +
        '<div class="cnt">' + cnt + '<small>라벨</small></div>';
      row.querySelector('input').onchange = function (e) {
        it.enabled = e.target.checked;
        renderItems(); resetRange(); render();
      };
      box.appendChild(row);
    });
    var total = P.buildLabels(st.items).length;
    $('#totalLabels').textContent = total + '장';
    $('#totalBar').hidden = false;
  }

  function resetRange() {
    var n = P.buildLabels(st.items).length;
    $('#f_from').value = 1;
    $('#f_to').value = Math.max(1, n);
  }

  /* ---- 라벨 HTML ---- */
  function labelHtml(label, total) {
    var text = payload(label, total);
    var w = String(total).length < 2 ? 2 : String(total).length;
    return '<div class="label">' +
      '<div class="qrcol">' +
        '<div class="qr">' + qrSvg(text) + '</div>' +
        '<div class="serial">' +
          '<div class="cap">NO.</div>' +
          '<div class="num">' + pad(label.seq, w) +
            '<span class="of"> / ' + pad(total, w) + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="fields">' +
        '<div class="f desc">' +
          '<div class="k">Description of Goods</div>' +
          '<div class="v">' + esc(label.desc || '—') + '</div>' +
        '</div>' +
        '<div class="f">' +
          '<div class="k">INVOICE NO.</div>' +
          '<div class="v">' + esc(st.invoiceNo || '—') + '</div>' +
        '</div>' +
        '<div class="f">' +
          '<div class="k">DATE</div>' +
          '<div class="v">' + esc(st.dateText || '—') + '</div>' +
        '</div>' +
        '<div class="f">' +
          '<div class="k">Quantity</div>' +
          '<div class="v">' + fmtQty(label.qty) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ---- 미리보기 ---- */
  function render() {
    var r = rebuild();
    var root = $('#previewRoot');
    var ready = !!(st.invoiceNo && st.dateText && r.n);

    $('#payloadPreview').textContent = r.n
      ? payload(st.labels[0], r.n)
      : '파일을 올려주세요';

    $('#btnPrint').disabled = !ready;
    $('#btnPrint2').disabled = !ready;

    if (!ready) {
      root.innerHTML = '<div class="empty"><div class="big">▦</div>' +
        '<h3>인보이스 파일이 필요합니다</h3>' +
        '<div>파일을 올리면 품목·수량·파렛트 구성을 읽어<br>' +
        '파렛트마다 QR 라벨을 만들어 드립니다.</div></div>';
      $('#cnt').textContent = '—';
      return;
    }

    var count = r.to - r.from + 1;
    $('#cnt').innerHTML = '<b>' + count + '</b>장 인쇄 · 번호 <b>' + r.from +
      '</b> ~ <b>' + r.to + '</b> / 전체 <b>' + r.n + '</b>장 · A4 <b>' +
      Math.ceil(count / 2) + '</b>장';

    var html = '';
    for (var i = r.from - 1; i <= r.to - 1; i++) html += labelHtml(st.labels[i], r.n);
    root.innerHTML = '<div class="sheet"><div class="labels">' + html + '</div></div>';
  }

  /* ---- 엑셀 읽기 ---- */
  function apply(res) {
    st.invoiceNo = res.invoiceNo || '';
    st.dateText = res.dateText || '';
    st.items = (res.items || []).map(function (it) { it.enabled = true; return it; });
    $('#f_inv').value = st.invoiceNo;
    $('#f_date').value = st.dateText;
    renderItems(); resetRange(); render();
  }

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: true });
        var res = P.extract(XLSX, wb);
        $('#fileName').textContent = file.name;
        $('#fileRow').hidden = false;
        $('#drop').classList.add('loaded');
        $('#dropT1').textContent = '읽기 완료';
        $('#dropT2').textContent = res.sheet ? '시트: ' + res.sheet : '';
        apply(res);

        var n = st.labels.length;
        if (res.invoiceNo && n) {
          $('#srcNote').className = 'note';
          $('#srcNote').innerHTML = '자동으로 읽었습니다 · <b>' + esc(res.source) + '</b><br>' +
            '품목 ' + st.items.length + '건 · 파렛트 ' + n + '개 → 라벨 <b>' + n + '장</b>';
          toast(res.invoiceNo + ' · 라벨 ' + n + '장');
        } else if (res.invoiceNo && !n) {
          $('#srcNote').className = 'warn';
          $('#srcNote').innerHTML = '인보이스 정보는 읽었으나 <b>파렛트 구성</b>을 찾지 못했습니다. ' +
            (res.itemNote ? esc(res.itemNote) : 'unit a pallet / No. of pallet 열을 확인해 주세요.');
          toast('품목을 찾지 못했습니다');
        } else {
          $('#srcNote').className = 'warn';
          $('#srcNote').innerHTML = '이 파일에서 인보이스 정보를 찾지 못했습니다. 파일 형식을 확인해 주세요.';
          toast('자동 인식 실패');
        }
      } catch (e) {
        $('#srcNote').className = 'warn';
        $('#srcNote').textContent = '엑셀 파일을 여는 중 문제가 생겼습니다. 파일이 손상되지 않았는지 확인해 주세요.';
        toast('파일을 읽지 못했습니다');
      }
    };
    reader.onerror = function () { toast('파일을 읽지 못했습니다'); };
    reader.readAsArrayBuffer(file);
  }

  function clearFile() {
    $('#fileRow').hidden = true;
    $('#drop').classList.remove('loaded');
    $('#dropT1').textContent = '엑셀 파일을 올려놓으세요';
    $('#dropT2').textContent = '클릭해서 선택 · .xlsx / .xlsm';
    $('#fileInput').value = '';
    st.invoiceNo = ''; st.dateText = ''; st.items = [];
    $('#f_inv').value = ''; $('#f_date').value = '';
    renderItems(); render();
  }

  /* ---- 샘플 (업로드한 인보이스와 동일 구성) ---- */
  function sample() {
    apply({
      invoiceNo: 'KW260716-RM', dateText: 'Jul-16-2026', source: '샘플',
      items: [
        { desc: '1. COLD DRAWN PIPE(RB C-MDPS)_SIZE : 32.0x2.8',
          qty: 8100, groups: [{ unit: 1800, count: 4 }, { unit: 900, count: 1 }], pallets: 5 },
        { desc: '2. COLD DRAWN PIPE NX4/KA4 MSCL_(SIZE : 35.9x28x3.95)',
          qty: 18000, groups: [{ unit: 1200, count: 15 }], pallets: 15 }
      ]
    });
    $('#srcNote').className = 'note';
    $('#srcNote').innerHTML = '샘플 값입니다. 실제 파일을 올리면 자동으로 바뀝니다.';
  }

  /* ---- 이벤트 ---- */
  function bind() {
    var drop = $('#drop'), input = $('#fileInput');
    drop.onclick = function () { input.click(); };
    input.onchange = function (e) { if (e.target.files[0]) readFile(e.target.files[0]); };
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files[0]; if (f) readFile(f);
    });
    $('#btnClear').onclick = function (e) { e.stopPropagation(); clearFile(); };

    $('#f_inv').oninput = function (e) { st.invoiceNo = e.target.value.trim(); render(); };
    $('#f_date').oninput = function (e) { st.dateText = e.target.value.trim(); render(); };
    ['#f_from', '#f_to'].forEach(function (s) {
      $(s).addEventListener('input', render);
      $(s).addEventListener('change', render);
    });
    $('#btnAllRange').onclick = function () { resetRange(); render(); };
    $('#btnPrint').onclick = function () { window.print(); };
    $('#btnPrint2').onclick = function () { window.print(); };
    $('#btnSample').onclick = sample;
  }

  function init() { bind(); renderItems(); render(); }
  document.addEventListener('DOMContentLoaded', init);
})();
