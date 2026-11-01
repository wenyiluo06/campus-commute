/* ===================================================================
   Mock 识别：模拟「上传课表图片 → OCR/解析 → 结构化 JSON」全过程
   - 只返回演示用的假数据；将来接真实 OCR / 解析服务时，
     只需替换 recognize() 的内部实现，其余流程
     （State → 核对表格 → 入库）完全不用动。
   - 用法：MockRecognize.recognize(file).then(rows => {...})
   =================================================================== */
window.MockRecognize = (function () {
  "use strict";

  // 演示课表（与 common.js 的示例一致；第 1 节与首页通勤卡片联动）
  // weeks / week_type 等周次字段模拟「从课表图片识别提取」的结果：
  // 大学英语是单周，体育只上前 8 周，用于演示第六步的单双周与起止周次。
  var BASE = [
    { name: "高等数学（必修）", start: "10:00", end: "11:40", room: "教三楼 302",   weeks: "1-16" },
    { name: "大学英语",        start: "14:00", end: "15:40", room: "外语楼 105",    weeks: "1-16 单周" },
    { name: "程序设计基础",    start: "16:00", end: "17:40", room: "计算机楼 401",  weeks: "2-15" },
    { name: "线性代数",        start: "19:00", end: "20:40", room: "教二楼 208",    weeks: "1-16" },
    { name: "体育（篮球）",    start: "08:00", end: "09:40", room: "体育馆 B 区",   weeks: "1-8" }
  ];

  function toRows() {
    var parse = (window.ScheduleCore && window.ScheduleCore.parseWeeks)
      ? window.ScheduleCore.parseWeeks
      : function () { return { start: null, end: null, type: "all" }; };
    return BASE.map(function (c, i) {
      var p = parse(c.weeks);
      return {
        idx: i + 1,
        course_name: c.name,
        start_time: c.start,
        end_time: c.end,
        location: c.room,
        weeks: c.weeks,
        start_week: p.start,
        end_week: p.end,
        week_type: p.type
      };
    });
  }

  /**
   * 识别课表文件（Mock）
   * @param {File} file   用户上传的文件
   * @param {Object} opts { delay: 模拟识别耗时(ms，默认 900) }
   * @returns {Promise<Array>} 归一化后的课表行
   */
  function recognize(file, opts) {
    opts = opts || {};
    var delay = opts.delay == null ? 900 : opts.delay;
    var fileName = (file && file.name) || "课表";
    return new Promise(function (resolve) {
      setTimeout(function () {
        console.log("[MockRecognize] 已识别文件「" + fileName + "」→ 返回演示课表（" + BASE.length + " 门课）");
        resolve(toRows());
      }, delay);
    });
  }

  return {
    recognize: recognize,
    sample: function () { return toRows(); }
  };
})();
