/* =========================================================================
 * KOWOO 인보이스 QR — 인보이스 파싱 (parse.js)
 *  - (8) No. & Date of invoice → 인보이스 번호 / 날짜
 *  - (10) Description of Goods → 품목별 파렛트 구성
 *      ONE PALLET / PARTIAL PALLET / PARTIAL PALLET 3개 그룹
 *      각 그룹: unit a pallet · No. of pallet · total Q'ty
 * 브라우저 + Node 양쪽 동작 (테스트 가능하도록 UMD)
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KWInvoiceParse = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* 엑셀 원본 서식(mmm"-"d"-"yyyy)과 동일하게: Jul-16-2026 */
  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return MONTHS[d.getMonth()] + '-' + d.getDate() + '-' + d.getFullYear();
  }

  /* 엑셀 일련번호(1900 체계) → Date */
  function serialToDate(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 1 || n > 100000) return null;
    var d = new Date(Math.round((n - 25569) * 86400 * 1000));
    return isNaN(d) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      var n = parseFloat(v.replace(/,/g, ''));
      return isFinite(n) ? n : 0;
    }
    return 0;
  }
  function asDate(v) {
    if (v instanceof Date && !isNaN(v)) return v;
    if (typeof v === 'number') return serialToDate(v);
    return null;
  }

  function toGrid(XLSX, ws) {
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: true, defval: null });
  }

  function looksLikeInvoiceNo(v) {
    if (typeof v !== 'string') return false;
    var s = v.trim();
    if (s.length < 4 || s.length > 40) return false;
    if (!/\d/.test(s)) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9\-\/_. ]*$/.test(s)) return false;
    if (/^\(\d+\)/.test(s)) return false;
    return true;
  }

  /* ---------------------------------------------------------------------
   * 인보이스 번호 / 날짜
   * ------------------------------------------------------------------- */
  function extractHeader(grid, ws) {
    var out = { invoiceNo: '', date: null, dateText: '', source: '' };

    for (var r = 0; r < Math.min(grid.length, 40); r++) {
      var row = grid[r] || [];
      for (var c = 0; c < row.length; c++) {
        if (norm(row[c]).indexOf('nodateofinvoice') === -1) continue;
        var below = grid[r + 1] || [];
        var inv = '', dt = null;
        for (var k = c; k < Math.min(below.length, c + 12); k++) {
          if (!inv && looksLikeInvoiceNo(below[k])) inv = String(below[k]).trim();
          if (!dt) { var d = asDate(below[k]); if (d) dt = d; }
        }
        if (inv || dt) {
          out.invoiceNo = inv; out.date = dt; out.dateText = fmtDate(dt);
          out.source = '라벨 "(8) No. & Date of invoice" 기준';
          return out;
        }
      }
    }
    // 폴백: G4 / J4
    if (ws && ws['G4'] && looksLikeInvoiceNo(String(ws['G4'].v))) {
      out.invoiceNo = String(ws['G4'].v).trim();
      var d4 = ws['J4'] ? asDate(ws['J4'].v) : null;
      out.date = d4; out.dateText = fmtDate(d4);
      out.source = '고정 위치 G4 / J4';
    }
    return out;
  }

  /* ---------------------------------------------------------------------
   * 품목 / 파렛트 구성
   * ------------------------------------------------------------------- */
  function extractItems(grid) {
    var res = { items: [], headerRow: -1, descCol: 0, qtyCol: -1, groups: [], note: '' };

    /* 1) 파렛트 그룹 헤더 찾기.
       두 가지 서식을 모두 지원:
         (a) 'unit a pallet' + 'No. of pallet'
         (b) "Q'ty/pallet"   + 'No. of pallet' / 'No of pallet'
       각 그룹 = {단위수량 열, 파렛트수 열}. one/partial pallet 여러 개 가능. */
    var hRow = -1, groups = [];
    function isUnitHdr(v) {
      var n = norm(v);
      return n === 'unitapallet' || n === 'qtypallet';   // "Q'ty/pallet" → qtypallet
    }
    function isCountHdr(v) {
      var n = norm(v);
      return n.indexOf('noofpallet') === 0 || n === 'noofpallet' || n.indexOf('nofpallet') === 0;
    }
    for (var r = 0; r < Math.min(grid.length, 40) && hRow === -1; r++) {
      var row = grid[r] || [], found = [];
      for (var c = 0; c < row.length; c++) {
        if (!isUnitHdr(row[c])) continue;
        var cntCol = -1;
        for (var k = c + 1; k < Math.min(row.length, c + 5); k++) {
          if (isCountHdr(row[k])) { cntCol = k; break; }
        }
        found.push({ unitCol: c, countCol: cntCol === -1 ? c + 1 : cntCol });
      }
      if (found.length) { hRow = r; groups = found; }
    }
    if (hRow === -1) { res.note = '파렛트 구성 헤더(unit a pallet / Q\'ty/pallet)를 찾지 못했습니다.'; return res; }

    /* 2) Description of Goods / Quantity 열 */
    var descCol = 0, qtyCol = -1;
    for (var rr = 0; rr <= hRow; rr++) {
      var row2 = grid[rr] || [];
      for (var cc = 0; cc < row2.length; cc++) {
        var n2 = norm(row2[cc]);
        if (n2.indexOf('descriptionofgoods') !== -1) descCol = cc;
        if (n2.indexOf('quantity') !== -1 && qtyCol === -1) qtyCol = cc;
      }
    }
    res.headerRow = hRow; res.descCol = descCol; res.qtyCol = qtyCol; res.groups = groups;

    /* 3) 데이터 행 */
    for (var r3 = hRow + 1; r3 < grid.length; r3++) {
      var row3 = grid[r3] || [];
      var desc = row3[descCol];
      if (desc == null || !String(desc).trim()) continue;
      if (norm(desc).indexOf('total') === 0) continue;      // 합계 행 제외

      var gs = [];
      for (var gi = 0; gi < groups.length; gi++) {
        var unit = num(row3[groups[gi].unitCol]);
        var cnt = Math.round(num(row3[groups[gi].countCol]));
        if (unit > 0 && cnt > 0) gs.push({ unit: unit, count: cnt });
      }
      if (!gs.length) continue;                              // 이번 선적 대상 아님

      var sum = gs.reduce(function (a, g) { return a + g.unit * g.count; }, 0);
      var qty = qtyCol >= 0 ? num(row3[qtyCol]) : 0;

      res.items.push({
        desc: String(desc).trim(),
        qty: qty || sum,
        groups: gs,
        pallets: gs.reduce(function (a, g) { return a + g.count; }, 0),
        row: r3 + 1
      });
    }
    return res;
  }

  /* 품목 → 라벨 목록 전개 (인보이스 전체 통합 일련번호) */
  function buildLabels(items) {
    var out = [];
    (items || []).forEach(function (it, ii) {
      if (it.enabled === false) return;
      it.groups.forEach(function (g) {
        for (var i = 0; i < g.count; i++) {
          out.push({ desc: it.desc, qty: g.unit, itemIndex: ii });
        }
      });
    });
    out.forEach(function (l, i) { l.seq = i + 1; });
    return out;
  }

  /* 통합 추출 */
  function extract(XLSX, wb) {
    // packing list 계열 시트 우선 (오타 'pcking list' 등도 근사 매칭)
    function packRank(name) {
      var n = norm(name);
      if (n.indexOf('packinglist') === 0) return 0;
      if (n.indexOf('pckinglist') === 0 || n.indexOf('packing') === 0 ||
          n.indexOf('pcking') === 0) return 1;      // 오타/약칭
      return 2;
    }
    var names = wb.SheetNames.slice().sort(function (a, b) {
      return packRank(a) - packRank(b);
    });

    var best = null, headerOnly = null;
    for (var i = 0; i < names.length; i++) {
      var ws = wb.Sheets[names[i]];
      var grid = toGrid(XLSX, ws);
      if (!grid || !grid.length) continue;
      var h = extractHeader(grid, ws);
      var it = extractItems(grid);
      var r = {
        invoiceNo: h.invoiceNo, date: h.date, dateText: h.dateText,
        source: h.source, sheet: names[i],
        items: it.items, itemNote: it.note
      };
      // 품목이 실제로 잡힌 시트를 최우선으로 채택
      if (it.items.length) {
        // 인보이스 번호가 이 시트엔 없고 다른 시트에 있으면 채워줌
        if (!r.invoiceNo) {
          for (var j = 0; j < names.length; j++) {
            var h2 = extractHeader(toGrid(XLSX, wb.Sheets[names[j]]), wb.Sheets[names[j]]);
            if (h2.invoiceNo) { r.invoiceNo = h2.invoiceNo; r.date = h2.date;
                                r.dateText = h2.dateText; r.source = h2.source; break; }
          }
        }
        return r;
      }
      if (h.invoiceNo && !headerOnly) headerOnly = r;   // 품목 없지만 인보이스는 있음
      if (!best) best = r;
    }
    return headerOnly || best || { invoiceNo: '', date: null, dateText: '', source: '',
                     sheet: '', items: [], itemNote: '' };
  }

  return {
    extract: extract, extractItems: extractItems, extractHeader: extractHeader,
    buildLabels: buildLabels, fmtDate: fmtDate, serialToDate: serialToDate,
    looksLikeInvoiceNo: looksLikeInvoiceNo
  };
}));
