/* 课表视觉识别：JSON 解析（多形态）+ 字段归一化（含星期 day）
   无浏览器，vm 模拟 window/document；只验证纯逻辑，不触网。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } }

const sb = {
  console,
  document: { addEventListener() {}, createElement() { return { style: {}, querySelector() { return null; }, querySelectorAll() { return []; } }; } },
  setTimeout, clearTimeout,
  FileReader: function () {}, Image: function () {}, URL: { createObjectURL() {}, revokeObjectURL() {} },
  window: null,
};
sb.window = sb;
function load(file) { vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sb, { filename: file }); }
load("assets/js/config.js");
load("assets/js/schedule-core.js");
load("assets/js/llm.js");

console.log("=== 课表视觉识别：JSON 解析 + 字段归一化 ===");
// 视觉模型常见返回形态
const c0 = '[{"course_name":"高等数学","day":1,"start_time":"10:00","end_time":"11:40","location":"教三楼302","weeks":"1-16"}]';
const c1 = '```json\n[{"course_name":"大学英语","day":3,"weeks":"单周"}]\n```';
const c2 = '{"courses":[{"course_name":"体育","day":5,"weeks":"1-8"}]}';

const p0 = sb.LLM.extractJson(c0);
ok(Array.isArray(p0) && p0[0].day === 1, "纯数组 + day 字段解析");
const p1 = sb.LLM.extractJson(c1);
ok(Array.isArray(p1) && p1[0].course_name === "大学英语", "带代码块包裹的数组解析");
const p2 = sb.LLM.extractJson(c2);
ok(Array.isArray(p2) && p2[0] && p2[0].course_name === "体育", "包裹对象 {courses} 也能提取出数组（recognizeSchedule 直接用）");

// normalize 对 day / 周次的归一化
const rows = sb.ScheduleCore.normalize([
  { course_name: "高数", day: 1, weeks: "1-16", start: "10:00", end: "11:40" },
  { course_name: "英语", day: 3, weeks: "单周" },
  { course_name: "体育", day: 7 },
]);
ok(rows[0].day === 1 && rows[1].day === 3 && rows[2].day === 7, "normalize 保留 day（1=周一…7=周日）");
ok(rows[0].week_type === "all" && rows[1].week_type === "odd", "normalize 推断 week_type（单周→odd）");
ok(rows[0].start_week === 1 && rows[0].end_week === 16, "normalize 从 weeks 文本推断 start/end_week");
ok(rows[2].day === 7, "周日 day=7 保留（auto-push 会 %7 映射为周日）");

// normDay：把模型返回的多种星期写法归一为 1~7（修复“显示每天”bug 的关键）
ok(sb.LLM.normDay(1) === "1", "normDay 数字 1");
ok(sb.LLM.normDay(7) === "7", "normDay 数字 7");
ok(sb.LLM.normDay("周一") === "1", "normDay 中文「周一」→1");
ok(sb.LLM.normDay("星期日") === "7", "normDay 中文「星期日」→7");
ok(sb.LLM.normDay("周三") === "3", "normDay 中文「周三」→3");
ok(sb.LLM.normDay("Mon") === "1", "normDay 英文 Mon→1");
ok(sb.LLM.normDay("sun") === "7", "normDay 英文 sun→7");
ok(sb.LLM.normDay("") === "", "normDay 空→空（UI 显示每天）");
ok(sb.LLM.normDay("每天") === "", "normDay 每天→空");
ok(sb.LLM.normDay("foo") === "", "normDay 无法识别→空");

console.log("\n=== 分段右重叠「截断副本」模糊去重（nameSimilar）===");
ok(sb.LLM.nameSimilar("高等数学", "高等数学") === true, "完全相同 → 相似");
ok(sb.LLM.nameSimilar("高等数学", "等数学") === true, "缺首字（等数学⊂高等数学）→ 相似");
ok(sb.LLM.nameSimilar("高等数学", "高等") === true, "缺尾字（高等⊂高等数学）→ 相似");
ok(sb.LLM.nameSimilar("高等数学", "线性代数") === false, "不同课程 → 不相似");
ok(sb.LLM.nameSimilar("大学物理", "大学英语") === false, "易混但不同 → 不相似");
ok(sb.LLM.nameSimilar("数学", "高等数学") === true, "连续子串（数学⊂高等数学）→ 相似");

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
