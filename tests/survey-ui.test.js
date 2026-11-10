import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("软件调研使用连续表单、模块进度和必填缺口导航", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");

  assert.match(source, /function surveyQuestionProgress/);
  assert.match(source, /function surveyTableIsComplete/);
  assert.match(source, /function updateSurveyEditorProgress/);
  assert.match(source, /function bindSurveyEditorInteractions/);
  assert.match(source, /data-survey-missing-toggle>只看必填待补/);
  assert.match(source, /data-survey-expand-all>全部展开/);
  assert.match(source, /data-survey-editor-complete=/);
  assert.match(source, /await activeDraftAutosave\?\.flush\(\)/);
  assert.match(source, /已完成模块默认折叠，点击目录可快速定位/);
  assert.match(source, /data-survey-jump=/);
  assert.match(source, /data-survey-required-missing/);
  assert.match(source, /data-survey-tables-complete/);
  assert.match(source, /调研记录\$\{question\.required \? "（必填）" : "（选填）"\}/);
  assert.match(source, /解决方案及补充（选填）/);
  assert.match(source, /dialogClass: "survey-editor-dialog"/);
  assert.match(source, /复用已有调研（可选）/);
  assert.match(source, /只复制问答与专项清单，不复制附件/);
  assert.match(source, /class="survey-special-row" data-survey-table-row/);
  assert.match(source, /String\(field\?\.label \|\| ""\)\.trim\(\) === "对接内容"/);
  assert.match(source, /<textarea \$\{attributes\} rows="1" data-survey-auto-grow/);
  assert.match(source, /survey-special-field\$\{longField \? " is-long" : ""\}/);
  assert.match(source, /还有必填字段未填写，填写完整后才能完成确认/);
  assert.match(source, /completeButton\.disabled = !allComplete/);
  assert.match(source, />完成确认<\/button>/);
  assert.match(source, /function resizeSurveySpecialTextarea/);
  assert.match(source, /maximumHeight = 220/);
  assert.match(source, /resizeSurveySpecialTextareas\(list\)/);
  assert.match(source, /对接内容可填写较长文字并自动展开；其余字段保持紧凑/);
  assert.match(source, /本清单以简短字段为主，按实际情况逐项填写/);
  assert.doesNotMatch(source, /title: "本题附件"/);
  assert.doesNotMatch(source, /survey-data-table/);
  assert.doesNotMatch(source, /<section class="survey-module">/);

  assert.match(css, /\.dialog\.survey-editor-dialog \{[^}]*height: min\(900px, calc\(100vh - 40px\)\)/s);
  assert.match(css, /\.survey-editor-layout \{[^}]*grid-template-columns: 215px minmax\(0, 1fr\)/s);
  assert.match(css, /\.survey-outline \{[^}]*position: sticky/s);
  assert.match(css, /\.survey-question-row \{[^}]*grid-template-columns: minmax\(240px, \.95fr\)/s);
  assert.match(css, /\.survey-editor\.show-required-missing \.survey-question-row:not\(\.is-required-missing\)/);
  assert.match(css, /\.survey-special-fields \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.survey-special-field\.is-long \{[^}]*grid-column: 1 \/ -1/s);
  assert.match(css, /\.survey-required-alert \{[^}]*background: #fff8e8/s);
  assert.match(css, /\.survey-special-field textarea \{[^}]*min-height: 42px[^}]*max-height: 220px[^}]*overflow-y: hidden/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.survey-question-row \{ grid-template-columns: 1fr;/);
});

test("日常导航不再展示历史 Excel 迁移，管理员可维护版本化调研模板", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const navFunction = source.match(/function navItems\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(navFunction, /Excel 导入|imports/);
  assert.match(source, /function surveyTemplateSettingsSection/);
  assert.match(source, /调研模板管理/);
  assert.match(source, /复制为新版本/);
  assert.match(source, /发布后不可覆盖/);
  assert.match(source, /data-template-add-module/);
  assert.match(source, /data-template-add-question/);
  assert.match(source, /data-template-add-table/);
  assert.match(source, /data-template-add-field/);
  assert.match(source, /data-template-field-type/);
});
